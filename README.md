# dsh-account-bridge

把**账号级**上游订阅（ChatGPT/Codex、Antigravity、Claude、WorkBuddy、Qoder、CommandCode…）
统一桥接进 DeepSeek Harness 的插件：一个插件、一份账号表、一套调度，而不是每家用一个插件。

> 状态：**P2.5**（骨架 + Codex 族 + Claude 族 + Antigravity 族 + 本机账号统一发现）。
> 三条 route 已在真实 DSH 宿主里验证可见（provider / 模型目录 / 登录流 / 工具面）；
> Antigravity 族已跑通真实推理；本机发现 → 一键导入 → 模型出现在选择器，这条链路已在真机上走通。
> 尚未跑过 Codex/Claude 的真实登录，也还没有客户端 UI。

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
| 把 Antigravity 家族注册成 provider route（`acct-agy`，显示名 `Antigravity (Google)`） | ✅ 真机验证 |
| 模型目录进 GUI 选择器（账号池 = 所有账号目录的并集） | ✅ 真机验证（无账号时为空目录，不报错） |
| 目录未知时**不宣称任何 reasoning effort**（不承诺兑现不了的东西） | ✅ 真机验证 |
| 登录流进 `ctx.authorization`（`dsh-account-bridge/{codex,claude,agy}-login`） | ✅ 真机验证 |
| 四个工具：`account_bridge_discover` / `account_bridge_accounts` / `account_bridge_login` / `account_bridge_accounts_remove` | ✅ 真机验证 |
| **本机账号统一发现**：一次扫完所有族的凭据位点，如实分四类（可导入 / 已导入 / 有凭据但导不进来 / 这族还没写） | ✅ 真机验证 |
| **一键导入**：`account_bridge_discover({import:true})` 把扫到的登录态收进账号池，无需任何粘贴或登录 | ✅ 真机验证（导入后 `acct-agy` 立刻列出 14 个模型） |
| 启动时后台扫一遍本机登录态并打日志（可用 `discoverOnStartup:false` 关掉） | ✅ 真机验证 |
| 本机 Codex CLI 登录态发现与导入（`~/.codex/auth.json`） | ✅ 单测 + 真机（含 API-key 模式如实报「不可导入」） |
| 本机 Claude Code 登录态发现与导入（`~/.claude/.credentials.json`） | ✅ 单测 + 真机（本机无该文件，如实返回空） |
| 驱动本机 `agy` CLI 推理（NDJSON 流 → DSH chunk，含 usage 与失败归类） | ✅ 真机推理通过 |
| 本机 agy 登录探测与导入（`agy models` 探针 + 14 个模型的真实目录解析） | ✅ 真机验证 |
| Anthropic 线协议翻译（system 分块 / cache 断点 / tool_result 配对 / SSE 分槽累积） | ✅ 单测 |
| 客户端版本号诚实化（查 npm registry，拿不到就用兜底常量并如实标注） | ✅ 单测 |
| 账号池调度：会话粘性 + 首个实质输出前才允许换号 + 冷却表 | ✅ 单测 |
| Codex / Claude 的真实登录 + 真实推理 | ⛔ 未验证（本机没有这两个订阅账号） |
| 客户端设置界面（`settings.section` / 用量徽章） | ⛔ 未做 |
| 其余族（WorkBuddy / Qoder / zcode / minimax / 通用兜底 `generic`） | ⛔ 未做（架构已就位，见 `src/families/`） |

## Antigravity 族（`agy`）：四个实话

这一族是**驱动本机 `agy` CLI 子进程**，不是直连 Google 私有 API。这是个有代价的选择，
下面四条都是实测出来的，写在这里免得你装完才发现：

1. **必须本机装了 agy CLI 并已登录。** 「登录」得你自己在**终端**里跑一次 `agy` 完成——
   授权码要贴回 agy 自己的控制台，而 DSH 是 GUI 进程、给不了它控制台，
   管道喂码 agy 根本不读（60 秒硬超时）。所以插件只做「探测 + 导入」，不做插件内登录。
2. **每一回合固定烧掉约 27k input tokens**，哪怕你只问一个「PONG」——
   那是 agy 自带的系统提示 + 57 个工具 schema。用这一族要按这个量级算成本。
3. **它是委派型，不是工具调用型。** agy 用它自己的 57 个工具、在它自己的 cwd 里干活；
   DSH 的工具给不了它，它的工具活动也不会变成 DSH 的 tool-call 块。我们只把文本交回 DSH。
4. **Windows / macOS 上实际只能挂一个账号。** agy 1.2.8 把令牌存进**系统凭据管理器**
   （Windows 是 `cmdkey` 里的 `LegacyGeneric:target=gemini:antigravity`），那是**按用户**
   而不是按 HOME 隔离的，target 名也不含路径成分 ⇒ 给子进程换 HOME 隔离不出第二个账号。
   与其假装支持多账号，不如照实说。

顺带一提：这一族**不在**宿主内置 `llm-pi-ai` 的约 40 个 provider 里（那里面有 `openai-codex`、
`anthropic`、`xai`… 但没有 Antigravity），所以它补的是宿主确实没有的格子。

配置项：`agyBin`（不在 PATH 上时给绝对路径）、`agyWorkdir`（agy 的工作目录，它是个 agent，
会往 cwd 里写东西）。

## 本机账号统一发现（P2.5）

社区里所有账号级反代插件都只认**自己**的登录流程，没有一个会去问「这台机器上已经有哪些客户端
登录过了」。结果是用户装了四个插件、把同一个 Google 账号登了四次。这一层补的就是这个空白位：

```bash
# 只看，不动任何东西
account_bridge_discover
# 收下所有能导入的
account_bridge_discover  { import: true }
```

真机输出长这样（这台机器上 `agy` 已登录、`codex` 是 API-key 模式、装过 WorkBuddy）：

```
本机账号发现（2026-10-08T10:26:50.185Z）

可以导入（1）
- agy ｜ agy CLI（本机登录）

扫到了凭据，但这一族还没写（1）
- workbuddy ｜ C:\Users\…\workbuddy-desktop.info ｜ workbuddy 族尚未实现（计划书 P6）｜凭据 5.6 起是 AES-256-GCM 密文…

有凭据但导不进来（1）
- codex ｜ Codex CLI（API key 模式，无订阅令牌） ｜ auth.json 里没有 OAuth tokens，只有 API key
```

两条刻意的设计：

- **发现不等于导入。** 扫描只读，一个字节都不写；导入是另一个显式动作。
  启动时那次自动扫描也**只打日志**，不会替你收下任何账号。
- **做不到的要如实说。** 本机装了我们还没实现的族的客户端时，报「探测到了凭据，但这一族还没写」
  ——而不是假装没看见，也不是给一个导入后必然失败的条目。
  `src/discover.js` 里的 `UNSHIPPED_SITES` 就是这张「欠账表」，加族时要把它删掉。

实现上值得一提的两点：

- **「已经导入过」靠指纹比对，不靠新字段。** 指纹取凭据里**不轮换**的那部分
  （`accountId` → `refresh` → … → 文件路径 → `access` → label），所以对 P2.5 之前写下的账号
  同样有效。顺序里把 `access` 压到很后面、把文件路径放在它前面，是因为 access token 每次刷新都变：
  拿它当身份，同一份登录态在刷新前后会被当成两个账号，一键导入就会反复插入重复条目。
- **一个族挂住不能拖垮整次扫描。** 每族独立超时（默认 15s）并各自 catch；
  扫描的全部价值就在于「在用户还没指定族的时候把所有族都问一遍」，所以这里不能用 `Promise.all`。



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
  cli-run.js          驱动上游 CLI 的子进程层（进程树 kill / 超时 / 撕裂行拼接）
  discover.js         本机登录态统一发现与一键导入（每族独立超时 + 身份指纹）
  login/
    loopback.js       PKCE + 回环回调服务器
    broker.js         「拿到 URL」与「登录完成」解耦
  wire/
    sse.js            SSE 解析
    responses.js      DSH 消息 ↔ OpenAI Responses API（Codex）
    anthropic.js      DSH 消息 ↔ Anthropic Messages API（Claude）
    agy.js            agy NDJSON ↔ DSH chunk（纯函数，用真实抓包做夹具）
  families/
    codex.js          Codex 族（协议常量、登录、目录、额度、推理）
    claude.js         Claude 族
    agy.js            Antigravity 族（驱动本机 agy CLI）
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

有一例真机推理测试默认跳过（每回合要烧 27k tokens，不该在每次 `npm test` 时都跑）：

```bash
BRIDGE_LIVE_AGY=1 node --test test/agy.test.js
```

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
