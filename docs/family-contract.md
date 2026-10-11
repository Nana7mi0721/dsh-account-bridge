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
  // options = { payload, model, messages, tools, effort, system, maxTokens, signal,
  //             account, session }
}
```

`account` 与 `session` 是给**上游身份**用的，两个都可以是 `undefined`：

| 字段 | 形状 | 用途 |
|---|---|---|
| `account` | `{ id, label }` | `id` 是账号池里的账号 id（如 `claude-1`）。**按账号分命名空间靠它** |
| `session` | `string \| undefined` | 调用方那段对话的**裸** id（会话里第一条 user 消息的 id）。**不许原样发给上游** |

**规矩：`session` 必须经 `accountScopedSession(family, account.id, session)` 派生后再发**
（见 `src/wire/identity.js`）。为什么要派生、以及「身份要么整套铺、要么一个都别铺」，
那两段说明在 `src/wire/identity.js` 的文件头。一句话版本：

- 发**裸** id ⇒ 上游看到「同一段对话从两个安装打过来」，一次换号就把两个账号连起来了；
- 每轮换一个 id ⇒ 上游 prompt cache 全废，你每次都付全量输入的钱；
- 派生值 ⇒ 同账号同会话稳定（缓存还在），跨账号不同（不连坐）。

需要发这个标识的字段有三处，**三处必须是同一个值**：
`x-claude-code-session-id`（头）、`metadata.user_id`（体）、`prompt_cache_key`（体）。
拿不到 `account` 或 `session` 时**一个都不发**，也不要退回去发裸 id。

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

**别把目录里读到的元数据丢掉。** 上游的 `/models` 里常常带着真正的模态与窗口
（`architecture.input_modalities`、`context_length`），而 `resolveModel(provider, model)` 只拿到
一个**模型名**。宿主要用它决定「这张图要不要换成一句占位文字」——`resolveModel` 回
`inputModalities: ['text']` 时，宿主会在请求到达族之前把图片块换成
`[image omitted because this model accepts text only; attachment sha256:…]`，
族里再怎么写图片翻译都发不出去。所以：`listModels()` 见到什么就在模块级记一份
（`src/families/generic.js` 的 `catalogMemory` 是现成模板，且**声明式目录不许覆盖目录里见过的真元数据**），
`resolveModel` 从记忆里取，取不到才回保守默认值。

### 5.4 宿主交来的消息：图片是引用，不是字节

宿主交给适配器的图片块是

```js
{ type: 'image', attachment: { attachmentId: 'sha256:…', mediaType, bytes, width, height, name? } }
```

**没有 `data`**。翻译层（`src/wire/*.js`）都按 `{ type: 'image', mediaType, data }` 写，所以池子
在进翻译层之前统一解引用一次（`src/pool.js` 的 `#withImageData`，读不到就报
`IMAGE_REF_UNRESOLVED` / `IMAGE_READ_FAILED` 并**原样留下那个块**，不吞）。族**不用自己处理这件事**，
但要知道两点：

- 要宣明 `inputModalities` 含 `image`，否则图根本到不了这里（见上一节）。
- 拿宿主服务的唯一入口是 `ctx.get(name)`（`ctx` 就是 `src/index.js` 的 `familyContext`，
  它的 `get` 转到 `serviceOf(ctx, name)`）。**`familyContext` 曾经没有 `get`**，
  于是 `ctx.get?.('attachments')` 恒为 undefined、每张图都被静默丢掉——加新服务时先确认这条路通。
- 助手轮的消息带 `source: { kind: 'model', provider, model }`（回放态就挂在它上面）；
  缺了宿主会在 `source.replayState` 上抛。

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

### 8.1 这个仓库只有端到端测试

没有单元测试，也没有回归测试文件。写完一个族要做的是四件事：

1. **在 `test/e2e/probe/index.js` 里加一条检查**：用 `account_bridge_*` 工具造出需要的账号 →
   让池子**真的发一次请求** → 断言宿主看见的那份东西（chunk 序列 / `finish.reason.kind` /
   `failure.code` / 回环数据面的字段）；
2. **需要上游配合演事故时，在 `test/e2e/mock-upstream.mjs` 里加一个模型**（它本来就是
   故意难伺候的验收台：不认 `stream_options`、不认 `cache_control`、Anthropic 那条路只发
   `data:` 不发 `event:`、还有几个专演事故的模型）。**不许为了让自己那关过而把它改宽容**；
3. **静态规矩加进 `test/e2e/preflight.mjs`**——只有「一眼能判定、且错了后果很贵」的才配
   （例：源码不许按裸模块名 import 核心包、会写盘的源码只准是哪两个文件）；
4. 跑：

```bash
npm test                          # 全套端到端
node test/e2e/harness.mjs         # 同时把宿主输出转出来
node test/e2e/harness.mjs --quiet # 安静模式
```

断言写在**探针里**，`test/e2e/e2e.test.js` 只负责把报告翻译成测试结果，一行判断都不要加。

**为什么不留单元测试**：它们证明的是「我以为的协议是自洽的」。这个插件几乎每一条规矩
都是从真机撞出来的（思考算不算输出、失败归哪一类、签名要不要回放），所以留下的证据只有真机。
代价要认：单元测试能守住「我知道的那条规则」不被改动，端到端守不住这个——它只证明接上去是对的。

### 8.2 一条检查要覆盖到哪几类

- **注册与目录**：`llm.listProviders()` 里有这条 route、`listModels()` 不为空、
  `resolveModelInfo()` 的 `contextWindow` 是正整数、只出图的模型没进选择器；
- **请求形状**：发出去的 URL / 头 / body 关键字段——尤其是伪装身份的那几个头，
  少一个就是静默失效。假上游会把**收到的每一笔请求原样记下来**（`GET /__requests`，
  只留最近 50 笔），所以探针可以这样问自己那一笔：
  `trace(model, marker)` 会先 `DELETE /__requests`、发一次带唯一标记的请求、再按标记找回记录，
  断言 body 的确切形状（`test/e2e/probe/index.js` 里两条「请求形状」检查就是模板）。
  想让一笔请求**必然**走某条方言，用只挂在那条方言目录里的模型（`mock-openai-only` /
  `mock-anthropic-only`）——池子是按目录过滤账号的；
- **凭据不泄漏**：`/account-bridge/state` 的响应里**绝不该**出现 `auth.access` / `auth.refresh` /
  `auth.apiKey` 的值；
- **失败归类**：401 → `AUTH`、429 + 额度词 → `ACCOUNT_QUOTA`、429 + 限流词 → `RATE_LIMIT`
  且 `providerRetryAfterMs` 有值；
- **chunk 序列**：`block-start` → delta → `block-end` → `usage` → `finish`，且
  `finish.reason.kind` 只在三个合法值里；
- **空回答抛 `EMPTY_RESPONSE`**，以及**失败那次的思考没有泄漏给调用方**；
- **「翻译回显」**（替代已删掉的 golden 快照）：让假上游回**脚本化的流**，断言宿主最终看见的
  chunk 序列与元数据。已经这样守住的七条：工具调用拼成一个 JSON 字符串且收尾是 `tool-calls`、
  后到的零值不擦掉已读到的用量、截断归 `max-tokens`、思考签名一个字符不丢、
  默认不回放上一轮的签名、两种方言的请求形状。新写翻译层时，照这个套路给**你新增的**
  那种帧补一条——`mock-upstream.mjs` 里 `chatToolCallChunks()` / `anthropicSignedThinkingEvents()`
  这些脚本化流就是模板。
- **诊断账本**：翻译层丢了东西时，`GET /account-bridge/diagnostics` 里要看得到
  （探针每轮把它 `say` 进日志，`/pool lost` 与它读同一本账）。

### 8.3 端到端跑在真宿主里，不在假宿主里

`test/e2e/harness.mjs` 起的是**真的无头 DSH**（`<exe> <cli.js> --profile e2e`），插件按 `link:`
装进去 ⇒ **改 `src/` 立刻生效，改探针要重跑**。所以「假宿主上过了」这种话在这里不成立，
但也别把它当成真上游：探针面对的是假上游，真上游仍要人工过一遍（见 §9）。

---

## 9. 真机验收（写完必须做）

端到端探针证明了「接上真宿主是对的」，但它的上游是假的。**真上游**仍要人工过一遍：

1. 在隔离 profile 里跑起来（`bash _dsh_research/dshrun.sh --profile plug`，
   `DSH_HOME` 指向 `_dsh_test`，**不碰用户真实 profile**）；
2. `llm.listProviders()` 里出现 `<route>` 与正确的 `displayName`；
3. `llm.listModels(route)` 列出真实模型（不是空）；
4. `llm.resolveModelInfo(route, <真实模型 id>)` 返回合理的 `contextWindow`；
5. **真的推理一次**，拿到流式文本；
6. `authorization.list()` 里有 `<route 的登录流>`；
7. 工具面注册成功。

第 5 条最容易漏——注册上了不等于能用。本机没有那种账号时，**如实写「真机未验」，不许写成通过**。

---

## 10. 提交前自检

- [ ] 没有 `import ... from '@deepseek-ai/*'`（profile 的 `node_modules` 里没有这些包，
      只能经 `ctx` 服务访问；`test/e2e/preflight.mjs` 有静态检查会拦）
- [ ] 没有 `export default`
- [ ] `route` 没和别的族撞
- [ ] 上游调用一律 `ctx.fetch(url, init, payload.proxy)`
- [ ] 发了任何会话标识时，它来自 `accountScopedSession(...)`，**不是** `options.session` 原样
      （三处一致：会话头 / `metadata.user_id` / `prompt_cache_key`）
- [ ] `refresh` 返回的是 **auth 对象**，且带全所有会变的键
- [ ] 一次性轮换的令牌有写回，且有 generation CAS
- [ ] 借来的代码/规则在 `THIRD_PARTY_NOTICES.md` 里登记了，且文件头注明了来源
- [ ] 没有的证据写「未知」，没有的额度不报，不支持的多账号不假装支持
- [ ] `npm test` 绿（端到端），探针里加了这座族自己的检查
- [ ] 真机验收七条过了，或者**如实写明哪几条没条件过**
