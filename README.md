# dsh-account-bridge

把**账号级**上游订阅（ChatGPT/Codex、Antigravity、Claude、WorkBuddy、Qoder、CommandCode…）
统一桥接进 DeepSeek Harness 的插件：一个插件、一份账号表、一套调度，而不是每家用一个插件。

> 状态：**P1**（骨架 + Codex 族 + Claude 族打通，两条 route 已在真实 DSH 宿主里验证可见：
> provider / 模型目录 / 登录流 / 工具面）。
> 尚未跑过真实登录，也还没有客户端 UI。

## 它和「key 级接入」的区别

- **key 级**：填一个 API Key，按量计费。DSH 自带「自定义提供方」就能做，本插件不做这件事。
- **账号级**（本插件）：复用你在某个客户端/订阅里的**登录态**（OAuth 令牌、桌面端凭据文件），
  以该客户端自己的身份发请求，走的是那条订阅的额度。这也是它需要单独存在的原因：
  凭据怎么拿、怎么刷、怎么在一堆账号之间调度，是 key 级完全不存在的问题。

## 它和宿主内置订阅登录的区别（定位）

DSH 0.2.0 起，宿主**内置**了 `@deepseek-ai/dsh-llm-pi-ai`，已经能登：`openai-codex`（ChatGPT Plus/Pro）、
`anthropic`（Claude Pro/Max）、`xai`（SuperGrok / X Premium）、`github-copilot`、`kimi-coding`、
`openrouter`、`radius`、`meta`，以及约 40 个 API-key provider。

所以本插件的卖点**不是「能不能接上某个订阅」**——单账号接入宿主已经有了。它是：

| 宿主内置单账号登录 | 本插件 |
|---|---|
| 一个 provider 一份凭据 | **一个族 N 个账号**，账号表在插件里 |
| 额度用完/被限流 = 报错 | 429 / 配额耗尽**自动换下一个账号** |
| 无失败记忆，每次都撞同一堵墙 | 按 `(族, 账号, 模型)` 记冷却，冷却中的账号直接跳过 |
| 换账号 = 换 provider | 模型选择器里是**并集**，会话内**粘住**同一账号（保住上游 prompt cache） |
| 一个插件一族 | 一个插件多族，共用一套调度与一套 UI |

## 现在能做什么

| 能力 | 状态 |
|---|---|
| 把 Codex 家族注册成 provider route（`acct-codex`，显示名 `ChatGPT (Codex)`） | ✅ 真机验证 |
| 把 Claude 家族注册成 provider route（`acct-claude`，显示名 `Claude (Subscription)`） | ✅ 真机验证 |
| 模型目录进 GUI 选择器（账号池 = 所有账号目录的并集） | ✅ 真机验证（无账号时为空目录，不报错） |
| 目录未知时**不宣称任何 reasoning effort**（不承诺兑现不了的东西） | ✅ 真机验证 |
| 登录流进 `ctx.authorization`（`dsh-account-bridge/{codex,claude}-login`，各两种方式） | ✅ 真机验证 |
| 三个工具：`account_bridge_accounts` / `account_bridge_login` / `account_bridge_accounts_remove` | ✅ 真机验证 |
| 本机 Codex CLI 登录态发现与导入（`~/.codex/auth.json`） | ✅ 单测（含 API-key 模式如实报「不可导入」） |
| 本机 Claude Code 登录态发现与导入（`~/.claude/.credentials.json`） | ✅ 单测 + 真机（本机无该文件，如实返回空） |
| Anthropic 线协议翻译（system 分块 / cache 断点 / tool_result 配对 / SSE 分槽累积） | ✅ 单测 |
| 客户端版本号诚实化（查 npm registry，拿不到就用兜底常量并如实标注） | ✅ 单测 |
| 账号池调度：会话粘性 + 首个实质输出前才允许换号 + 冷却表 | ✅ 单测 |
| 真实登录 + 真实推理 | ⛔ 未验证（本机没有这两个订阅账号） |
| 客户端设置界面（`settings.section` / 用量徽章） | ⛔ 未做 |
| Antigravity（`agy`）等其余族 | ⛔ 未做（架构已就位，见 `src/families/`） |

## 安装（开发期）

插件目录就是这个仓库根。直接把它 `link:` 进 profile，改源码即时生效：

```bash
dsh plugin --profile <profile> add "<绝对路径>/dsh-account-bridge"
```

`dsh` 在桌面版里是这样调的（Windows）：

```bash
export ELECTRON_RUN_AS_NODE=1
"<安装目录>/DeepSeek Harness.exe" "<安装目录>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" <参数...>
```

## 目录结构

```
src/
  index.js            插件入口：apply / name / inject
  pool.js             账号池适配器（实现 dsh-llm 的适配器契约）
  health.js           失败归类 → 冷却建议 → 冷却表
  store.js            账号记录（落在 ctx.credentials）
  tools.js            工具面（库内自足，不 import 核心包）
  http.js             per-账号 出站代理（undici ProxyAgent）
  cli-version.js      上游客户端版本号（查 npm registry，失败静默回退）
  login/
    loopback.js       PKCE + 回环回调服务器
    broker.js         「拿到 URL」与「登录完成」解耦
  wire/
    sse.js            SSE 解析
    responses.js      DSH 消息 ↔ OpenAI Responses API（Codex）
    anthropic.js      DSH 消息 ↔ Anthropic Messages API（Claude）
  families/
    codex.js          Codex 族（协议常量、登录、目录、额度、推理）
    claude.js         Claude 族
    registry.js       族注册表
```

## 三条真机/源码才暴露的契约（已钉成回归测试）

1. **适配器是鸭子类型，但少一个方法就当场注册失败。**
   `registerAdapter` 在注册时**无条件**调用 `adapter.providerRetryPolicy(provider)`；
   `?? resolveRetryPolicy(...)` 只兜返回值，兜不住「方法不存在」，于是报
   `adapter.providerRetryPolicy is not a function`。运行时真正会调用的适配器方法恰有 7 个：
   `providerInfo` / `providerRetryPolicy` / `imageRequestPricing` / `listModels` / `resolveModel` / `prepareCall` / `stream`。
   → 见 `test/contract.test.js`。

2. **插件不能按裸模块名 import `@deepseek-ai/*` 核心包。**
   profile 的 `node_modules` 是 pnpm 扁平布局，`@deepseek-ai/` 下只有 `cosmokit` 与 `schemastery`；
   核心包只存在于 `app.asar` 里，**只能经 `ctx` 服务访问**。实测报
   `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'`。
   需要核心能力时的两条正路：① 经 `ctx` 服务；② 库内自足实现（本插件的工具定义就是自己拼的）。
   → 见 `test/contract.test.js` 的静态检查。

3. **`finish.reason.kind` 只认三个值：`'stop' | 'tool-calls' | 'max-tokens'`。**
   写别的（比如 `'success'` / `'tool-use'`）不会报错，但语义**静默丢失**——宿主拿不到
   「这轮是工具调用」就不会续跑，拿不到 `'max-tokens'` 就不会做截断处理。
   → 见 `test/anthropic.test.js` 的六种 `stop_reason` 断言。

## 测试

```bash
node --test "test/*.test.js"
```

注意 `node --test test/`（目录形式）在 Node v24 上会报 `Cannot find module .../test`，要写 glob。

## 设计要点

- **静态 `inject` 恒为空数组**，一律用惰性 `ctx.inject([...], cb)`：静态注入一个该 composition
  里不存在的服务会让 entry 永久 pending，而 loader 把 pending 当 **profile 加载失败**。
- **流式换号只在「一个字都还没吐出去」时做**。`block-start` 不算输出，`block-end` 带内容才算；
  一旦有实质输出，失败只能记健康状态，绝不重放（否则用户会看到重复文本）。
- **会话粘性**：同一会话尽量用同一个账号，保住上游的 prompt cache；粘性键取会话里
  第一条 user 消息的 id（历史会被重放，所以这个键跨轮稳定）。
- **刷新按账号合并 in-flight promise**：refresh token 通常一次性轮换，并发刷新会把账号踢下线。
  DSH 凭据记录的独占写只解决跨进程，解决不了同进程并发。
- **失败粒度是 `(族, 账号, 模型)`**：配额失败在按模型分线的族（Claude、Antigravity）只停那一格，
  其它族停整个账号；`400/422` 是请求本身的问题，**谁都不罚**。
- **导入来的凭据是「外部所有」**：默认只读，刷新出的新令牌不回写对方的文件，避免和 CLI 互相踩。

## 未定事项

- LICENSE：尚未添加（社区 DSH 插件惯例是 MIT，但加之前需要作者确认——不加就等于保留所有权利）。
- 首发族补齐顺序、第二档（zcode / minimax）、通用兜底族 `generic`：见计划书。
