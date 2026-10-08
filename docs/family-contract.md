# 写一个「族」（family）

> 这份文档的目标：**不读别的族，也能写对一个新的族。**
> 契约是从 DSH 宿主 0.2.0-rc.2 的真实调用面 + 本仓已跑通的四个族里反推出来的，
> 每条都注明了「不这样会怎样」。

---

## 0. 一个族要回答的六个问题

写之前先把这六个问题答完，答不出来的部分就是还没调研清楚：

1. **凭据从哪来？** 本机有没有别的客户端已经把登录态落盘（路径 + 格式 + 加密与否）？
   没有的话，登录流程要走哪条（回环 OAuth / device flow / 粘贴令牌）？
2. **令牌会不会一次性轮换？** 会 ⇒ 刷新后**必须写回原处**，否则等于替用户把账号踢下线。
3. **上游推理端点是什么？** 完整 URL、每个请求头的确切字符串值、请求体形状、SSE 事件名。
4. **模型目录从哪来？** 动态接口（URL + 返回形状）还是硬编码快照？查不到就别编。
5. **额度查得到吗？** 有就实现 `quota` 并画进度条；**没有就别实现**——
   报一个假的剩余额度比不报更糟。
6. **哪些失败该换号、哪些该罚账号？** 见 §6。

---

## 1. 文件布局

一个族 = 最多三个文件，**不要动别人的文件**：

```
src/families/<id>.js     族本体（导出 `export const <id>Family`）
src/wire/<id>.js         线协议翻译（纯函数，无状态，好测）
test/<id>.test.js        测试
```

如果这一族的协议是**已有的某套**（OpenAI Chat Completions / Anthropic Messages），
就直接复用现成的翻译层，**不要再抄一份**：

| 上游协议 | 复用什么 |
|---|---|
| Anthropic Messages（`/v1/messages`） | `src/wire/anthropic.js`：`toAnthropicSystem` / `toAnthropicMessages` / `toAnthropicTools` / `translateAnthropicStream` |
| OpenAI Chat Completions（`/v1/chat/completions`） | `src/wire/chat-completions.js`：`toChatSystem` / `toChatMessages` / `toChatTools` / `translateChatStream` |
| OpenAI Responses API | `src/wire/responses.js` |
| 私有信封 | 自己写 `src/wire/<id>.js`，但要照 §5 的 chunk 契约输出 |

`src/families/registry.js` 由维护者统一改（避免多人同时编辑冲突），
新族写完先在自己的测试里单独 import 它。

---

## 2. 族对象的确切形状

```js
export const fooFamily = {
  id: 'foo',                    // 必须匹配 /^[a-z][a-z0-9-]*$/，且必须与文件名一致
  displayName: 'Foo (订阅)',     // 设置页与授权流里显示的名字
  route: 'acct-foo',            // provider route，必须匹配 /^[a-z][a-z0-9-]*$/，全插件唯一
  risk: 'low',                  // 'low' | 'medium' | 'high' —— 只用于 UI 提示

  // ↓ 以下全部可选；不实现就是「这一族没有这个能力」，不要写空壳
  discover(),                   // 本机登录态发现（见 §4）
  recordFromDiscovery(item),    // discover 的产物 → 账号记录
  login: { methods, run },      // 登录（见 §4）
  refresh(ctx, payload, signal),// 令牌刷新，**返回新的 auth 对象**（见 §3.2）
  needsRefresh(payload, now),   // 现在要不要刷
  listModels(ctx, payload, signal),
  resolveModel(provider, model),
  quota(ctx, payload, signal),
  stream(ctx, options),
}
```

### 硬约束

- **`route` 必须全插件唯一**。重复了 `assertUniqueRoutes` 会在启动时抛。
- **`route` 只注册一次**。宿主 `ctx.llm.registerAdapter` 的语义是「一个 route 一个适配器」，
  池子（`src/pool.js`）会为**每一族**返回同一个适配器对象、只按 `provider` 参数分流。
- **不要 `export default`**。别的族都是具名导出，混用会让维护者找不着。
- **`id` 用于凭据记录键**：`<scope>/<family>-<n>`，例如 `dsh-account-bridge/foo-1`。
  改 `id` 等于让所有已有账号失联。

---

## 3. 凭据记录（`payload`）

记录由 `src/store.js` 管，落在 DSH 的 credentials seam 上。**payload 没有任何 schema 校验**，
所以 `auth` 里可以自由放字段（`minimax` 族就在里面放了 `region`）。

### 3.1 记录的形状

```js
{
  family: 'foo',
  label: '用户的邮箱或昵称',      // 显示用
  source: 'oauth' | 'client-import' | 'manual',
  externallyOwned: true | false, // true = 令牌另有一份主人（本机客户端），我们只是借用
  auth: { /* 全部凭据字段，见下 */ },
  proxy: undefined,              // 可选出站代理
  disabled: false,
  createdAt: 1712345678901,
  updatedAt: 1712345678901,
}
```

- `health` / 冷却 / 额度快照 **不要**写进记录，那些在内存里（`src/health.js`）。
- `externallyOwned: true` 意味着**你必须考虑写回**（见 §3.3）。
- 绝不把明文令牌写进 `settings`（那是普通配置文件，会进备份和截图）。
  credentials seam 是唯一的落点。

### 3.2 `refresh` 的返回契约（**这条最容易写错**）

```js
/**
 * @returns {Promise<object>} 新的 auth 对象 —— 不是整个 payload！
 */
async refresh(ctx, payload, signal) { … }
```

池子的调用与合并是这样（`src/pool.js`）：

```js
const auth = await family.refresh(this.#ctx, account, undefined)   // signal 传 undefined
store.update(accountId, (current) => ({ ...current, auth: { ...current.auth, ...auth } }))
```

两条推论：

- **`refresh` 收到 `signal === undefined`**，所以里面**不能对 signal 做 `.addEventListener`**
  这类假设它存在的操作（可以 `signal?.addEventListener`，也可以自己造一个超时）。
- 合并是**浅合并**：返回的 `auth` 里没带的键会保留旧值。**显式带上所有会变的键**，
  否则陈旧值会留下来。

**并发刷新由池子按 accountId 合并 in-flight promise**，族里不用自己防。
但如果刷新会**写回本机文件**，就得自己防「另一个进程也在刷」——用 generation CAS，
参考 `src/families/minimax.js` 的 `writeBackDesktop`。

### 3.3 写回（只在 `externallyOwned` 时）

refresh token 一次性轮换的上游，你不写回就等于**替用户把他桌面端踢下线**。
写回必须满足：

1. **原子写**：同目录临时文件 + `rename`；
2. **CAS**：先重读，比对 generation / 版本号，不匹配就**放弃写**（别覆盖别人的新令牌）；
3. **权限 0600**；
4. **失败不连累刷新**：写不进去只 `ctx.log.warn`，刷新结果照常返回。

---

## 4. 登录与发现

### 4.1 授权流注册

`src/index.js` 会为**每一族自动**注册一个授权流：

```js
ctx.authorization.registerFlow({
  key: store.keyOf(store.loginSlot(family.id)),   // 'dsh-account-bridge/foo-login'
  label: family.displayName,
  methods,                                        // = family.login.methods
  run: (session) => family.login.run(session, familyContext),
})
```

⇒ **加族不用改 `src/index.js`。**

`login.methods` 是 `[{id, label}]` 数组，`id` 自己定（`'browser'` / `'import'` / `'manual'` / …）。

### 4.2 `session.prompt` 只有三种 kind，且**没有默认值字段**

```js
const answer = await session.prompt({ kind: 'text',   message: '……' })
const secret = await session.prompt({ kind: 'secret', message: '……' })   // 输入框不回显
const picked = await session.prompt({ kind: 'select', message: '……', options: [{ value, label }] })
```

- **没有 `initial` / `default` 字段**（我读过 `@deepseek-ai/dsh-authorization` 的类型定义，
  词汇表里就是这三个键）。写了会被忽略。
- `run()` **必须在 resolve 之前 commit**，否则 seam 抛 `NOT_COMMITTED`。
- 用 `session.notify({ message, url })` 把用户要点开的链接发出去。

### 4.3 agent 侧走不通交互式登录流（**必读**）

`src/login/broker.js` 给工具调用用的非交互实现，**只会自动回答「只有一个选项的 select」**，
其余一律抛：

```
account-bridge: the "<family>" login flow needs an interactive prompt (<kind>: <message>);
start it from the settings UI instead
```

⇒ 如果你的族在 agent 场景下也要能加账号，**必须另有一条无交互入口**
（`generic` 族的 `account_bridge_add_endpoint` 工具就是为这个存在的）。

### 4.4 `discover` 的契约

```js
discover(ctx) // → Array<{ family, sourcePath, label, importable, externallyOwned?, auth?, reason? }>
```

- `src/discover.js` **会跳过没有 `discover` 方法的族**（合法，`generic` 就没实现）。
- 只有 `importable === true` **且**族实现了 `recordFromDiscovery` 时，
  条目才会进「可导入」清单；否则进「有凭据但导不进来」并显示 `reason`。
- **有凭据但格式不对时必须 `importable: false` + 诚实写清 `reason`**，
  不要静默跳过——用户以为扫过了、其实没有，比报错更糟。
- 每个族的发现都有**独立超时**，别在里面做无限等待的事。

---

## 5. `stream` 的 chunk 契约

```js
async *stream(ctx, options) {
  // options = { payload, model, messages, tools, effort, system, maxTokens, signal }
}
```

最省事的写法是复用一个翻译层：

```js
const response = await ctx.fetch(url, init, payload.proxy, true)   // ← 第 4 个参数 = 流式
if (!response.ok) throw await httpError(response, await response.text(), 'foo')
yield* translateAnthropicStream(response, { signal })
```

**上游调用必须用 `ctx.fetch(url, init, payload.proxy, streaming)`** ——
直接 `fetch` 会让 per-账号出口代理失效（`src/http.js` 里是 undici `ProxyAgent`）。
第 4 个参数 `streaming` 是**必须传对**的：走代理且流式时它为 `true`，
`ProxyAgent` 才会用 `bodyTimeout: 0`（默认的 5 分钟会在长回答中途掐断连接，
表现为「说到一半莫名中断」）。**流式的请求一律传 `true`。**

### 5.1 chunk 的确切形状

| `type` | 其它字段 |
|---|---|
| `block-start` | `index: number`、`blockType: 'text' \| 'reasoning' \| 'tool-call'` |
| `text-delta` | `index`、`text: string` |
| `reasoning-delta` | `index`、`text: string` |
| `tool-call-delta` | `index`、`id?`、`name?`、`argumentsDelta: string` |
| `block-end` | `index`、`block: {...}`（见下） |
| `usage` | `usage: { inputTokens?, outputTokens?, cachedInputTokens?, cacheCreationInputTokens? }` |
| `finish` | `reason: { kind: 'stop' \| 'tool-calls' \| 'max-tokens' }` |

`block` 的三种形状：

```js
{ type: 'text',      text: '……' }
{ type: 'reasoning', text: '……' }
{ type: 'tool-call', id: '……', name: '……', arguments: '{"json":"string"}' }  // arguments 是字符串！
```

### 5.2 三条硬规矩

1. **`finish.reason.kind` 只认 `'stop' | 'tool-calls' | 'max-tokens'` 三个值。**
   写别的（`'success'` / `'tool-use'` / …）**不报错但语义静默丢失**：宿主拿不到
   「这轮是工具调用」就不会续跑，拿不到 `'max-tokens'` 就不会做截断处理。
2. **一个内容块都没出，要抛 `code = 'EMPTY_RESPONSE'`**，不要吐一个空的 `finish`。
   池子靠这个码决定「可以换号重试」。
3. **`block-end` 必须带真实内容**。`block-end` 带 text / id / arguments 才算
   「已经输出」，池子据此决定还能不能换号（见 §7）。

### 5.3 模型元数据

`listModels` 返回给宿主的条目，和 `resolveModel` 返回的形状：

```js
{
  provider,                                  // = family.route
  id, name,
  context: { contextWindow: 200_000 },
  defaultMaxTokens: 32_000,
  toolUpdate: 'in-history',
  inputModalities: ['text'],                 // 有图片才加 'image'；**没转发的能力不要声明**
  reasoning: { efforts: [...], defaultEffort },  // 只有真能拨档位时才声明
}
```

**不知道的值宁可保守也不要编。** 上下文窗口低估只是提前压缩，高估会把超长请求送上去
被拒、白烧一次额度（`agy` 族就是这么处理的，见它的注释）。

---

## 6. 失败归类

统一用 `src/wire/http-error.js`：

```js
import { httpError, retryAfterMs, mapStatus } from '../wire/http-error.js'
if (!response.ok) throw await httpError(response, await response.text(), 'foo')
```

`mapStatus(status, detail)` 的判定顺序是钉死的（改顺序会静默改变换号行为）：

```
401/403                     → AUTH
文本里有 invalid_grant 等   → AUTH        （OAuth 刷新失败常带 400）
402                         → ACCOUNT_QUOTA
429 + quota/usage limit     → QUOTA
429 其它                    → RATE_LIMIT
400 + context 字样          → CONTEXT_WINDOW_EXCEEDED
408 / 504                   → TIMEOUT       （必须在 >=500 之前，否则 504 永远落不到）
其余                        → SERVER
```

`src/health.js` 的 `classifyFailure` 再把它翻成「换不换号 / 冷却多久 / 罚谁」：

| `error.code` | 动作 | 冷却 | 范围 |
|---|---|---|---|
| `QUOTA` / `ACCOUNT_QUOTA` / `RATE_LIMIT` | 换号 | 5min（或 `Retry-After`） | 按模型分线的族罚 member，其余罚 account |
| `AUTH` / `INVALID_CREDENTIAL` / `MISSING_CREDENTIAL` | 换号 | 24h | account |
| `SERVER` / `TIMEOUT` / `EMPTY_RESPONSE` | 换号 | 60s | member |
| `TRANSPORT` | 换号 | **不记**（网络问题不代表账号有问题） | — |
| `CONTEXT_WINDOW_EXCEEDED` / 400 / 422 | **不换**（换谁都一样） | 谁都不罚 | — |
| 其它 | 不换 | — | — |

**额度按模型分线的族**（现在只有 `claude`）：配额失败只停「该账号 × 该模型」，
别的模型照样能用 ⇒ 加进 `MODEL_SCOPED_QUOTA_FAMILIES`。

---

## 7. 池子替你做的事（别重复实现）

`src/pool.js` 已经做了：

- **会话粘性**（上限 1000 条、TTL 30 分钟）——为的是让上游的 prompt cache 命中；
- **只在「一个字都还没吐出去」时换号**：`block-start` 不算输出，`block-end` 带
  text / id / arguments 才算；`usage` / `finish` 不算。**已经吐字之后绝不重放**；
- **按 accountId 合并 in-flight 刷新**（refresh token 一次性轮换的上游必需）；
- **模型目录 = 全池并集**（不是当前账号的），失败开放；
- 冷却表（`src/health.js`）与 `lastWhy` 可解释性。

⇒ 族里**不要**自己写轮询、重试、换号逻辑。族只负责「拿这一个账号、发这一次请求」。

---

## 8. 测试

### 8.1 跑法

```bash
node --test "test/foo.test.js"      # 单族
node --test "test/*.test.js"        # 全量
```

**必须写 glob。** `node --test test/`（目录形式）在 Node v24 上报
`Cannot find module .../test`。

### 8.2 用现成的 harness

```js
import { createMockHost, recordingCtx, sseResponse, errorResponse } from './harness.js'

const { ctx, credentials, dispose } = createMockHost()
// ctx 上已经有 llm / tools / authorization / credentials 的假实现
// 默认 discoverOnStartup: false，不会在构造时打网络

const { ctx: recCtx, calls } = recordingCtx(async (url, init) => sseResponse([...]))
// calls 里是 [{ url, init, proxy }]，用来断言「发出去的请求长什么样」
```

`sseResponse(events)` 的事件写成 `{ event: 'content_block_start', data: {...} }`。
**注意**：它**总是**会写出一行 `event:`，所以表达不了「上游只发 `data:`、没有事件名」
这种情况——那种测试要自己造响应（见 `test/anthropic.test.js` 里的例子）。

`errorResponse(status, body, headers)` 造一个非 2xx 响应。

### 8.3 一定要测到的几类

- **请求形状**：URL、每个头、body 的关键字段（尤其伪装身份的头，少一个就是静默失效）；
- **凭据不泄漏**：令牌不该出现在日志 / 错误消息里（用 `redact`）；
- **失败归类**：401 → `AUTH`、429+quota → `QUOTA`、上游 400 的 context 错误 →
  `CONTEXT_WINDOW_EXCEEDED`；
- **chunk 序列**：`block-start` → delta → `block-end` → `usage` → `finish`，且
  `finish.reason.kind` 只在三个合法值里；
- **空回答抛 `EMPTY_RESPONSE`**；
- **`payload.proxy` 透传**到 `ctx.fetch`；
- **`discover` 的四种结果**：可导入 / 已导入 / 有凭据但导不进来（带 reason）/ 没装。

### 8.4 联网测试要能跳过

真机测试（真的打上游）**默认必须跳过**，用一个环境变量开：

```js
test('...', { skip: process.env.BRIDGE_LIVE_FOO !== '1' }, async () => { … })
```

理由：它会烧真实额度、还要求本机装好并登录了那个客户端。

---

## 9. 真机验收（写完必须做）

单测只能证明「我以为的协议是自洽的」。真机验收清单：

1. 在隔离 profile 里跑起来（`bash _dsh_research/dshrun.sh --profile plug`，
   `DSH_HOME` 指向 `_dsh_test`，**不碰用户真实 profile**）；
2. `llm.listProviders()` 里出现 `<route>` 与正确的 `displayName`；
3. `llm.listModels(route)` 列出真实模型（不是空）；
4. `llm.resolveModelInfo(route, <真实模型 id>)` 返回合理的 `contextWindow`；
5. **真的推理一次**，拿到流式文本；
6. `authorization.list()` 里有 `<route 的登录流>`；
7. 工具面注册成功。

第 5 条最容易漏——注册上了不等于能用。

---

## 10. 提交前自检

- [ ] 没有 `import ... from '@deepseek-ai/*'`（profile 的 `node_modules` 里没有这些包，
      只能经 `ctx` 服务访问；`test/contract.test.js` 有静态检查会拦）
- [ ] 没有 `export default`
- [ ] `route` 没和别的族撞
- [ ] 上游调用一律 `ctx.fetch(url, init, payload.proxy)`
- [ ] `refresh` 返回的是 **auth 对象**，且带全所有会变的键
- [ ] 一次性轮换的令牌有写回，且有 generation CAS
- [ ] 没有的证据写「未知」，没有的额度不报，不支持的多账号不假装支持
- [ ] 真机验收七条都过了
