# dsh-account-bridge

把**账号级**上游订阅（ChatGPT/Codex、Antigravity、Claude、WorkBuddy、Qoder、CommandCode…）
统一桥接进 DeepSeek Harness 的插件：一个插件、一份账号表、一套调度，而不是每家用一个插件。

> 状态：**P6 完成**——骨架 + 11 个族（`codex` / `claude` / `agy` / `minimax` / `qoder` /
> `workbuddy` / `commandcode` / `grok` / `copilot` / `trae` / `generic`）+ 本机账号统一发现 +
> 设置页账号池面板 + `/pool` 命令族。11 条 route 已在真实 DSH 宿主里验证可见
> （provider / 模型目录 / 登录流 / 工具面 / 面板数据面），route 互不撞车。
> **真机跑通过推理的族**：`agy`、`minimax`、`generic`。其余族单测齐全但**没有可用的真账号**，
> 属于「真机未验」，逐族的取舍见下面的「族的状态与取舍」。
>
> 当前进行中：**P7 深度改进**（见 `dsh-account-bridge-深度改进计划书.md`）——修「对上游不诚实」
> 与「账号选得不对」这两类问题，11 个工作包。
>
> 许可：**MIT**。借用的上游代码逐条记在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，
> 并由 `test/notices.test.js` 双向强制（借了没登记、登记了文件不存在，都会红）。

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
| 把 MiniMax Code 家族注册成 provider route（`acct-minimax`，显示名 `MiniMax Code`） | ✅ 真机推理通过 |
| 模型目录进 GUI 选择器（账号池 = 所有账号目录的并集） | ✅ 真机验证（无账号时为空目录，不报错） |
| 目录未知时**不宣称任何 reasoning effort**（不承诺兑现不了的东西） | ✅ 真机验证 |
| 登录流进 `ctx.authorization`（`dsh-account-bridge/{codex,claude,agy}-login`） | ✅ 真机验证 |
| 把通用兜底族注册成 provider route（`acct-generic`，显示名 `通用 API（自建 / 中转）`） | ✅ 真机验证 |
| **本机账号统一发现**：一次扫完所有族的凭据位点，如实分四类（可导入 / 已导入 / 有凭据但导不进来 / 这族还没写） | ✅ 真机验证 |
| **一键导入**：`account_bridge_discover({import:true})` 把扫到的登录态收进账号池，无需任何粘贴或登录 | ✅ 真机验证（导入后 `acct-agy` 立刻列出 14 个模型） |
| 启动时后台扫一遍本机登录态并打日志（可用 `discoverOnStartup:false` 关掉） | ✅ 真机验证 |
| 本机 Codex CLI 登录态发现与导入（`~/.codex/auth.json`） | ✅ 单测 + 真机（含 API-key 模式如实报「不可导入」） |
| 本机 Claude Code 登录态发现与导入（`~/.claude/.credentials.json`） | ✅ 单测 + 真机（本机无该文件，如实返回空） |
| 驱动本机 `agy` CLI 推理（NDJSON 流 → DSH chunk，含 usage 与失败归类） | ✅ 真机推理通过 |
| 本机 agy 登录探测与导入（`agy models` 探针 + 14 个模型的真实目录解析） | ✅ 真机验证 |
| 本机 MiniMax Code 登录态发现与导入（`~/.minimax/auth/prod/{en,cn}/mcode-public/auth.json`） | ✅ 真机验证 |
| MiniMax Code 令牌刷新 + **写回桌面端**（generation CAS，防两边互相踩） | ✅ 真机验证（对真实文件跑通，令牌每刷必换是实测事实） |
| Anthropic 线协议翻译（system 分块 / cache 断点 / tool_result 配对 / SSE 分槽累积） | ✅ 单测 |
| 客户端版本号诚实化（查 npm registry，拿不到就用兜底常量并如实标注） | ✅ 单测 |
| 账号池调度：会话粘性 + 首个实质输出前才允许换号 + 冷却表 | ✅ 单测 |
| 把 Qoder 家族注册成 provider route（`acct-qoder`，显示名 `Qoder (China)`） | ⚠️ 单测通过，**真机未验**（本机没装 Qoder、没有 PAT） |
| 把 WorkBuddy 家族注册成 provider route（`acct-workbuddy`） | ⚠️ 单测通过，**真机仅验到第一条**（本机凭据是 5.6 的密文） |
| 把 CommandCode 家族注册成 provider route（`acct-commandcode`） | ⚠️ 单测通过，**真机未验**（本机没有 CommandCode 账号） |
| **设置页里的「账号池」面板**：看每个族的账号、起登录、导入、停用、续期、设代理、删号、查额度、扫本机 | ✅ 真机验证（路由真机可用 + 28 个面板用例） |
| **`/pool` 命令族**：`/pool` 看池子、`/pool check` 真查额度、`/pool unfreeze` 解冻冷却中的账号 | ✅ 真机验证（在宿主里 `commands.find(undefined,'pool')` 解出并跑通全部六个输入） |
| **设置 → 模型页的行内摘要**：每张 `acct-*` provider 卡片下方一行池子状态 + 页脚一整池的汇总 | ✅ 单测（席位形状、按 route 过滤、多卡共享一次请求）；**真的在浏览器里看见**待人工确认 |
| Codex / Claude 的真实登录 + 真实推理 | ⛔ 未验证（本机没有这两个订阅账号） |
| 用量徽章（`SubscriptionUsageBadge` 那种常驻角标） | ⛔ 未做（额度只在面板里按需查） |
| **任意 OpenAI / Anthropic 兼容端点**：填地址 + 密钥就能用，含 8 个预设（OpenRouter / DeepSeek / 硅基流动 / Moonshot / 智谱 / 百炼 / Ollama / LM Studio） | ✅ 真机端到端（用一个插件写代码时不知道其存在的假端点验收） |

## 设置页里的「账号池」面板

打开 DSH 的 设置 → 左侧导航最后一项「账号池」。它能做九件事：看每个族的账号与状态、
按族的登录方法起登录、从本机一键导入、停用/启用某个账号、续期令牌、给某个账号单独设代理、
删号、逐账号查额度、扫一遍本机有哪些客户端登录态可导入。

### 三条刻意的设计

1. **只有「有登录在跑」时才自动刷新。** 登录是跨进程、跨分钟的状态，必须自动跟；
   其余一律等你点按钮。这个面板每次「检查额度」都会真的打上游——做成自动轮询，
   等于拿你的账号去刷上游的风控。
2. **「额度未知」和「额度 0%」是两个句子。** 查不到就渲染一个灰的「额度 未知」，
   **连进度条都不画**。画一条 0% 宽的条会被读成「读数就是 0」——「查不到」和
   「用光了」对你要做的事来说是完全相反的两件事。
3. **凭据一个字节都不出宿主。** 数据面 `publicAccount()` 是**白名单式重建**：
   只放 id / 标签 / 来源 / 是否停用 / 是否可续 / 过期时间 / 代理 / 状态 / 冷却 / 额度。
   `auth.access`、`auth.refresh`、`auth.apiKey` 一律不外传；将来 `auth` 里加了新字段，
   默认也是不外传（白名单的好处就是**漏掉是安全的**，黑名单则是漏掉就泄密）。

### 这个面板背后的 HTTP 面，以及它为什么不设 token

浏览器里拿不到宿主对象，所以面板走一条插件自己挂的回环路由：
`POST /account-bridge/<action>`，信封是 `{ok:true, value}` 或 `{ok:false, error:{code,message}}`。

**它没有任何 token，理由是：不需要，而且加了会更糟。**

- 它**只服务回环**：`req.socket.remoteAddress` 只认 `127.0.0.1` / `::1` / `::ffff:127.0.0.1`，
  其余一律 403。这一面能起登录、能删账号，所以这条检查是硬性的。
- 它**不返回任何凭据**（见上面前两条），所以拿到响应也换不走账号。
- 真正的问题是「同机上的另一个本地进程能不能调它」。能不能？**能。**
  但那不是这条路由引入的风险——那个进程本来就能直接读你的 `~/.codex/auth.json`。
  给它加 token 只会得到一种错觉：让人以为「这个面是有防护的」。
  所以这里的选择是把边界写清楚，而不是加一层看起来像防护的东西。

## `/pool` 命令族（不开浏览器也能看池子）

```
/pool                        看每族的账号与健康（**不发任何网络请求**）
/pool check [族]             真去查一次额度（**会打上游**）
/pool unfreeze [族] [账号]   清掉冷却，让号立刻重新参与调度（`thaw` 同义）
```

三条设计约束：

1. **`/pool` 不发网络请求。** 它只读凭据记录与内存里的冷却表。想在对话里顺手看一眼池子
   是常事，而每一次自动查额度都是拿你的账号去碰上游的风控。
2. **`/pool check` 会把「这一族没有额度接口」和「有接口但这次没读出来」分开写。**
   两者都是「未知」，但含义不同：前者你永远等不到读数，后者值得再试一次。
3. **解冻那条命令会解释它为什么安全。** 冷却表是纯内存的派生状态，清掉最坏结果是
   下次再撞一次同样的失败、再记一条。不说清楚，人不敢用，账号就一直冻着——那才是真损失。

`/pool unfreeze codex-1` 会被认出来（`codex-1` 看起来是账号 id，不是族），并直接告诉你正确写法
是 `/pool unfreeze codex codex-1`。

命令面走宿主自己的 `ctx.commands.register()`，**不产生模型消息、不进模型历史**，所以问一句不烧额度。

## 设置 → 模型页上的两处摘要

模型页会给每张 provider 卡片留一个扩展位，插件在那里挂一行池子状态；页面底部还有一行整池汇总。
这两处都是**可选**的：席位被别人占了、或这一版宿主没声明它，都只警告不抛——
为了让一个可选摘要把整个插件（连同账号池面板）拉下来是不划算的。

**卡片摘要怎么落到我们的 provider 上**：那是 keyed 席位，key 是该 provider 的 `settingsNs`。
我们的 11 条 `acct-*` 都**没有**在「可配置 provider 目录」里声明过，宿主的
`joinProviderDirectory()` 给这类 provider 填的 `settingsNs` 就是**空字符串**，
所以用 `key: ''` 注册一条就能落到所有这些卡片上——组件内部再按 route 过滤，
别人的卡片一律返回 `null`。

**摘要不自己轮询**：模型页一打开可能有十几张卡片，每张各打一次 HTTP 就是十几次请求。
这里用模块级共享快照，一次取数、所有卡片订阅，30 秒内不重复取。

`ctx.remote` 那条路走不通：它是**构建期**生成的（typert + remote 双注册，路由谱系由构建工具产出），
第三方插件没有构建期，加不了路由。自己挂 `ctx.webServer.register({kind:'prefix', path, handler})`
是唯一可行的姿势——注意**重复 path 会抛**，所以要用 `ctx.inject(['webServer'], …)` 配 `webCtx.effect(() => dispose)`，
插件卸载时把路由摘干净。

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

## MiniMax Code 族（`minimax`）：三个实话

这一族直连 MiniMax Code 桌面端自己的网关（`https://agent.minimax.io/mavis/api/v1/llm/v1`），
用的是桌面端登录时拿到的那套 OAuth 令牌，协议是标准的 Anthropic Messages。
配置项：`MINIMAX_HOME`（默认 `~/.minimax`，测试/便携安装用；桌面端自己只认这个默认值）。

1. **不做订阅 Key。** 宿主内置的 `minimax` / `minimax-cn` provider 已经能填 `MINIMAX_API_KEY`
   走 `api.minimax.ai`，那是 key 级接入。mcode 的 OAuth 令牌与订阅 Key 是**两套凭据**——
   拿 mcode 令牌去调 `token_plan/remains` 会被回 `status_code:1004 login fail: Please carry
   the API secret key in the 'Authorization' field`，这是实测。
2. **没有动态模型目录。** 往 `{网关}/models` 打一定 `503 {"errorCode":50115,
   "errorReason":"direct_route_not_configured"}`，所以模型表就是 `~/.minimax/config.yaml` 里
   声明的四条快照（M3 / M3.1-Flash-Preview / M2.7 / M2.7-highspeed），`listModels` 一个网络
   请求都不发。好处是不会因为上游抽风把整族模型弄消失，代价是上游加新模型时得跟着改。
3. **刷新令牌是一次性的，而令牌文件是桌面端的。** 这是本族唯一真正危险的地方，值得单独一节说。

### 写回：为什么这一族要动桌面端的文件

MiniMax 的 refresh token **每用一次就轮换一次**：拿旧令牌换到新令牌的那一刻，旧令牌服务端
立刻作废（实测 `400 invalid_grant: this refresh token can no longer be used`）。
而令牌文件（`~/.minimax/auth/prod/<region>/mcode-public/auth.json`）是**桌面端和本插件共用的同一份**。

于是只有两种结局：

- **写回**：桌面端下次启动读到的就是新令牌，两边一直对齐。
- **不写回**：服务端已经换成新的了，文件里还是旧的 ⇒ **用户下次打开 MiniMax Code 直接被要求重新登录**。

所以 `minimax` 是唯一一个 `externallyOwned` 却**必然要写回**的族
（其它族一律只读，见「设计要点」最后一条）。写回按桌面端自己的做法来：同目录临时文件 + rename、
`generation` 做 CAS、先写凭据再写状态镜像。CAS 基准是**刷新前现读**的，不是导入时记下的那个。

**开发期真出过事。** 写回最初拿 `auth.generation ?? 0` 当基准，而账号记录里根本没有这个字段 ⇒
基准恒为 0、文件里是 16 ⇒ CAS 永远不匹配、永远静默不写。单测没抓住是因为测试自己贴心地
传了和文件一致的 generation。真机跑完的表现是：推理成功、记录里的令牌也换了，
**桌面端的文件纹丝不动**——服务端那条令牌已经作废。最后本机三个令牌（文件里的、探针备份里的、
记录里的）全部 `invalid_grant`，只能重新登录。

那次之后加了两道闸：

- **读不到桌面端凭据就根本不刷。** 写不回去的刷新等于单方面把用户踢下线，而且不可逆，
  所以宁可报 `AUTH` 让账号进冷却并提示「先打开 MiniMax Code 让它自己刷一轮」。
  `test/minimax.test.js` 里 `an externally owned account refuses to refresh when the desktop
  file is gone` 守着这条。
- **`loginEpoch` 进身份指纹。** 上面那个 bug 还顺带让同一份登录态被导入了两次
  （记录里是新令牌、文件里是旧令牌，指纹不一致 ⇒ 多出一个 `minimax-2`）。桌面端每次登录会
  生成一个 `loginEpoch` UUID，它不随刷新变化，正好当稳定标识。

仍然存在的**固有竞态**，说清楚：如果桌面端在我们这一来一回之间也刷了一次，双方必有一方的令牌
作废。CAS 只保证「不互相覆盖」，保证不了「两边的请求不会同时飞出去」。真撞上时的表现是插件这边
拿到 `invalid_grant` → AUTH → 账号进 24h 冷却，而桌面端是好的；重新导入一次即可。

## 通用兜底族（`generic`）：五个实话

1. **它其实不是「账号级反代」。** 别的族复用的是一个**登录态**（订阅额度、OAuth 会话）；
   这一族收的是一个**端点和一把密钥**。放在这里是因为「本机自建 / 内网中转」经常和反代被
   一起问，而宿主内置的 `llm-pi-ai` 已经把 OpenRouter / DeepSeek / Moonshot 这些主流云厂商
   的 key 接完了——**要接那些，宿主自带的更好用**，别绕这一族。这一族补的是宿主没有预设的格子：
   局域网里的 vLLM / SGLang、one-api / new-api / LiteLLM 这类中转网关、公司内网网关，
   以及 `/models` 返回不规范的野路子端点。
2. **没有 `discover`。** 它没有本机凭据位点可扫，所以「一键导入本机登录态」这条路对它不存在，
   只能手填或用 `account_bridge_add_endpoint` 工具加。别的族扫得到它扫不到，这是如实反映。
3. **没有 `refresh`。** API key 不会过期。所以这一族永远不会有「刷新失败」产生的冷却，
   也不会有任何写回本机的行为。
4. **没有 `quota`。** OpenAI 的接口语义里没有标准化的额度端点，Anthropic 也没有。
   与其声明式地编一个进度条，不如什么都不报——**报一个假的剩余额度比不报更糟**。
5. **它对上游的方言做了让步，每一处都是被真机逼出来的**（见下面的验收一节）。

### 验收方式：拿一个插件写代码时不知道其存在的端点

用真服务测证明不了「**任意**兼容端点都能接」——那只说明代码碰巧对上了那个服务。
所以验收用的是 `_dsh_research/mock-openai.mjs`：一个跑在 `127.0.0.1` 临时端口上的假端点，
模型名是编的，而且**刻意在方言上刁难**——

- Anthropic 那条路**只发 `data:` 行、不发 `event:` 行**（自建中转很常见的样子）；
- **不认 `stream_options`**：发了就 400；
- **不认 `cache_control`**：发了就 400（钉住「不冒充 Claude Code、不塞上游没要的字段」）；
- **必须带对的 `Bearer` / `x-api-key`**，否则 401。

真机结果（隔离 profile，`acct-generic`）：

```
llm.listModels(acct-generic) = [mock-alpha, mock-beta, declared-only]
LIVE generic OpenAI 方言 (mock-alpha) chunk count = 8 | text = "PONG"
LIVE generic Anthropic 方言 + 声明式目录 (declared-only) chunk count = 8 | text = "PONG"
```

`mock-image-only`（只出图的模型）**没有**进选择器，这是有意的；`declared-only` 只存在于
手填的声明式目录里，上游 `/models` 从不返回它，它照样能推理。

### 顺手修掉的一个会静默泄密的 bug

`normaliseBaseUrl`（用户只填 `api.example.com` 时自动补协议）原来用前缀判断私有网段：

```js
/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i
```

于是 `10.example.com` 被判定成内网、补成 `http://`——**一个把 API Key 明文发出去的静默降级**。
现在四个点分十进制字节写全，且后面必须紧跟 `(\/|$)`：只有**确实是**本机/内网 IP 的才补 `http`，
其余一律 `https`。取舍写在注释里：公网走 http 会在密钥离开本机之前就被中间人拿走，
而猜错的代价只是「请求失败」——后者用户一眼就能看出来。

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

- **「已经导入过」靠指纹比对，不靠新字段。** 指纹取凭据里**不轮换**的那部分，顺序是
  **稳定标识 → 文件路径 → 轮换的令牌 → label**（`accountId` / `loginEpoch` / `email` / `owner`
  → `sourcePath` → `refresh` / `access`），所以对 P2.5 之前写下的账号同样有效。
  这个顺序被真机教训改过两次：轮换的令牌（MiniMax Code 的 `refresh` 每刷必换）排在前面，
  插件刷完令牌就会把同一份登录态当成新账号再导一遍；而反过来只按路径认，一个族从
  Windows Local / Roaming 两个候选位置摸到同一份登录时又会被劈成两个账号。
  各族因此有义务把自己的稳定标识摆进 `auth`。
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
LICENSE                 MIT
THIRD_PARTY_NOTICES.md  借用了哪些上游代码、以什么许可借的、用在哪里
src/
  index.js            插件入口：apply / name / inject
  api.js              回环 HTTP 数据面（面板用的 POST /account-bridge/<action>）
  client.js           设置页「账号池」面板 + 模型页行内摘要/页脚（手写客户端模块，无构建步骤）
  commands.js         `/pool` 命令族（只读状态 / 真查额度 / 解冻冷却）
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
    anthropic.js      DSH 消息 ↔ Anthropic Messages API（Claude / MiniMax Code / 通用族）
    chat-completions.js  DSH 消息 ↔ OpenAI Chat Completions API（通用族）
    agy.js            agy NDJSON ↔ DSH chunk（纯函数，用真实抓包做夹具）
    qoder.js          Qoder 私有信封 + COSY 签名 + WAF body 编码（纯函数）
    workbuddy.js      WorkBuddy 私有层（信包、身份模仿头、额度三态）
    commandcode.js    CommandCode 三传输协商（cli / provider-chat / provider-messages）
    grok.js           Grok Responses 线（两个计费口径的端点评址 + 指纹头）
    copilot.js        Copilot 设备码 + editor-version 炸弹 + 目录映射
    trae.js           Trae 私有信封 + 私有 SSE + Electron 存储解密（只解不加密）
    http-error.js     共享的 HTTP 失败归类（AUTH / QUOTA / TIMEOUT / …→ LlmError）
    identity.js       上游身份：成套的头 + 按账号分的会话命名空间（见下面「会话身份」）
  families/
    codex.js          Codex 族（协议常量、登录、目录、额度、推理）
    claude.js         Claude 族
    agy.js            Antigravity 族（驱动本机 agy CLI）
    minimax.js        MiniMax Code 族（直连 mcode 网关 + 令牌写回桌面端）
    qoder.js          Qoder 族（PAT → jobToken，私有信封 + COSY 签名）
    workbuddy.js      WorkBuddy 族（只读借用桌面端凭据）
    commandcode.js    CommandCode 族（四源凭据回退 + 三传输）
    grok.js           Grok 族（默认走订阅口径的 cli-chat-proxy）
    copilot.js        Copilot 族（设备码；非公开接口，随时可能失效）
    trae.js           Trae 族（私有协议；凭据只读，不写回）
    generic.js        通用兜底族（任意 OpenAI / Anthropic 兼容端点）
    registry.js       族注册表
test/
  mini-react.js       够用的迷你 React（本仓库不把真 React 拉成 devDependency）
  responses.test.js   Responses 流翻译层（**原先零覆盖，两个真 bug 就藏在这里**）
  commands.test.js    `/pool` 命令族（含一个照抄宿主校验规则的假 `commands` 服务）
  identity.test.js    会话身份：同账号幂等、跨账号不同、裸会话 id 不许出现在请求里
  notices.test.js     许可与署名台账的双向自检（借了没登记 / 登记了文件不存在，都会红）
  fixtures/           COSY 定标向量 + Python 第二实现复核器（**树里没有任何私钥**）
docs/
  family-contract.md  「怎么加一个族」的完整规格——**想加族就先读这一份**
```

> `docs/family-contract.md` 是本仓最该先读的一份文档：族的对象形状、`stream` 的 chunk 契约、
> 失败归类表、凭据记录与写回 CAS、登录与发现的入口、测试与真机验收清单、提交前自检，都在里面。
> 本仓所有族的写法都按它来，新增族也应当如此。

## 会话身份：为什么发出去的 id 不是调用方的 id

上游看到的会话标识**必须按账号派生**，不能是调用方那个裸 id。三种做法，两种是错的：

| 做法 | 上游看到什么 | 后果 |
|---|---|---|
| 发裸会话 id | 「同一段对话从两个安装打过来」 | 一次换号就把两个账号连起来——正是风控要找的形状 |
| 每轮换一个 id | 每次都像新对话 | prompt cache 全废，每轮付全量输入的钱 |
| **按账号派生**（本仓） | 同账号同会话稳定、跨账号不同 | 缓存还在，且不连坐 |

派生在 `src/wire/identity.js`：`sha256(族 + 账号 id + 会话)` 取前 16 字节并置成 **UUIDv4 形状**
（上游对这个字段有形状校验，随便一串 hex 会被当成畸形值）。

`claude` 族把**同一个值**发在三处——`x-claude-code-session-id` 头、`metadata.user_id`（新 JSON 形态）、
以及（`codex` / `grok`）`prompt_cache_key`；三处必须一致，否则「成套」就破了。
拿不到账号或会话时**一个都不发**，也不会退回去发裸 id。
`test/identity.test.js` 里有断言直接扫整个请求，**裸会话 id 出现即失败**。

> 另外，`CLAUDE_CODE_IDENTITY` 里原本有一句
> "…running within the DeepSeek Harness account bridge."——那等于在第一段 system 里主动
> 告诉上游「这不是 Claude Code，是一个第三方桥」。已改为与官方客户端逐字一致的措辞，
> 并有测试钉住「system 里不许出现 bridge / harness」。

## 五条真机/源码才暴露的契约（已钉成回归测试）

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

4. **`readSse` 在没有 `event:` 行时会填 SSE 的默认事件名 `'message'`，而不是 `undefined`。**
   于是 `translateAnthropicStream` 里 `event.event ?? payload.type` 里的 `??` 是**永远走不到的死代码**
   ——Anthropic 的事件名里没有叫 `message` 的，`event.event` 恒为真。而自建中转只发 `data:`
   是常态（把事件名写在 `payload.type` 里）。现在按 `'message' | undefined` 显式回退。
   → 见 `test/anthropic.test.js` 里那例「自己造响应、不用 `sseResponse`」的用例：
   那个辅助函数**总是**会写出一行 `event:`，表达不了「没有事件名」这件事。

5. **失败码要靠 `error.failure` 才能活着走到用户面前，而那个对象少一个字段就整份作废。**
   宿主把适配器抛出的异常转成 `{type:'finish', reason:{kind:'error', failure}}`，转换函数是
   `@deepseek-ai/dsh-llm` 的 `normalizeLlmFailure()`：它只认「错误自己是 `HarnessError`」或
   「错误上挂着一个 `failure` 快照，且快照的 `code` 与错误的 `code` 相等」两条路，
   否则 `harnessErrorCode()` 一律返回 `"UNKNOWN"`。我们抛的是普通 `Error` 加一个 `.code`，
   两样都不占 ⇒ **每个族的失败码在 UI 与日志里都变成 `UNKNOWN`**，
   「令牌废了」和「中间有个东西挡着」再也分不出来。
   更阴的是 `failureSnapshot()` 的校验方式：`message` / `code` 必须是非空字符串，
   `status` 必须是 100..599 的整数，**任何一项不合格都会把整份快照判成 `undefined`**
   （不是忽略那一个字段）。我们原先挂了 `failure` 却漏了 `message`，于是这条路早就在、
   却一直没通。
   → 见 `src/failure.js`、`src/wire/http-error.js` 与 `test/failure.test.js`
   （那个文件里第一条用例是宿主算法的**复刻**：抄它的判定顺序，断言我们的错误真能过它）。

## 测试

```bash
npm test          # 等价于 node --test "test/*.test.js"
```

注意 `node --test test/`（目录形式）在 Node v24 上会报 `Cannot find module .../test`，要写 glob。

当前：**728 个用例，715 通过，0 失败，13 跳过**（跳过的是各族的真机联网用例——它们要么每回合烧掉真实额度，
要么本机根本没有那种账号；不该在每次 `npm test` 时都跑）：

```bash
BRIDGE_LIVE_AGY=1 node --test test/agy.test.js
```

需要联网、默认跳过的真机用例各有各的环境变量开关：
`BRIDGE_LIVE_AGY` / `BRIDGE_LIVE_QODER` / `BRIDGE_LIVE_WORKBUDDY` / `BRIDGE_LIVE_COMMANDCODE` /
`BRIDGE_LIVE_GROK` / `BRIDGE_LIVE_COPILOT` / `BRIDGE_LIVE_TRAE`
（其中 Qoder / CommandCode / Grok / Copilot / Trae 那几条**本机也跑不了**——没有 PAT、没有账号、没有订阅）。

**面板（`src/client.js`）怎么在没有浏览器的情况下测**：仓库里带了一个 60 行的迷你 React
（`test/mini-react.js`），够撑起 `createElement` / `useState` / `useEffect` / `useCallback` / `useRef`。
不把真 React 拉成 devDependency 的理由是：那会让 `npm test` 依赖一份**与宿主版本无关**的 React，
测出来的东西和真实运行环境的关系就说不清了。迷你 React 踩过两个坑，都值得记：
`useCallback` 依赖没变时**必须返回上一次那个函数**（返回新函数会让 `useEffect(fn, [cb])`
变成「取数 → setState → 依赖又变 → 再取数」的死循环）；每个用例必须**一棵全新的组件树**
（共用一棵树会让 hook 状态跨用例泄漏，测出来的绿是假的）。

MiniMax Code 那一族没有对应的联网测试：它的令牌是一次性的，跑一次就消耗掉一条真实登录态。
写回路径的验证方式是**拿真的 `auth.json`、只把令牌端点换成 stub**
（`_dsh_research/mcode-writeback-e2e.mjs` 那种做法），跑完从备份还原。

## 设计要点

- **静态 `inject` 恒为空数组**，一律用惰性 `ctx.inject([...], cb)`：静态注入一个该 composition
  里不存在的服务会让 entry 永久 pending，而 loader 把 pending 当 **profile 加载失败**。
- **流式换号只在「一个字都还没吐出去」时做**。`block-start` 不算输出，`block-end` 带内容才算；
  一旦有实质输出，失败只能记健康状态，绝不重放（否则用户会看到重复文本）。
- **「思考」也不算输出，但憋着有三个上限**（`src/pool.js`）。这条值得单独讲：Claude 会在
  想了 10–25 秒之后用安全策略**拒绝整轮**。把 `reasoning-delta` 当成「已经输出了」，
  用户吃到的就是那条拒绝，而**下一个账号从来没被问过**。

  | 条件 | 窗口 | 为什么 |
  |---|---|---|
  | 连思考都没有 | **15 秒** | 上游拿着连接不说话 |
  | 只有思考，且这一族会「想完就拒」 | **4 分钟** | Claude / GPT / Gemini 系会想很久再拒 |
  | 缓冲超过 1 MiB | 立即 | 防一个疯狂输出的上游把内存吃光 |

  **到期一律原样放行，不是丢弃**——代价是放行之后就不能再换号了（调用方已经看见了那些块）。
  不「想完就拒」的族（GLM、DeepSeek、Kimi、MiniMax…）仍在第一个思考事件上就提交：
  把它们憋住会让思考在正文开始时**一次性吐出来**。判据按**模型名**而定，不按族
  （`generic`/`copilot`/`trae` 一个族里什么模型都有）。
  **憋住期间不发保活**：那是外层网关（magpie / CLIProxyAPI）才有的动作，我们是进程内 adapter，
  没有能写 SSE 注释的那一层，宿主也没有流空闲超时（`dsh-llm` 里 `idle`/`stall`/`keepalive` 零命中）。
- **会话粘性**：同一会话尽量用同一个账号，保住上游的 prompt cache；粘性键取会话里
  第一条 user 消息的 id（历史会被重放，所以这个键跨轮稳定）。
- **刷新按账号合并 in-flight promise**：refresh token 通常一次性轮换，并发刷新会把账号踢下线。
  DSH 凭据记录的独占写只解决跨进程，解决不了同进程并发。
- **刷新失败同样记冷却，冷却期间不再重试刷新**。模型目录是靠刷新后的 payload 去拉的，
  刷新一失败目录就空；如果失败不进健康表，账号列表会一边说「健康」一边列出零个模型，
  而且目录不缓存失败 ⇒ 每次 `listModels` 都会再拿那条已经作废的令牌去打一次上游。
- **失败粒度是 `(族, 账号, 模型)`**：配额失败在按模型分线的族（Claude、Antigravity）只停那一格，
  其它族停整个账号；`400/422` 是请求本身的问题，**谁都不罚**。
- **导入来的凭据默认只读**：刷新出的新令牌不回写对方的文件，避免和 CLI 互相踩。
  唯一的例外是 `minimax`——它的刷新令牌是一次性的、而令牌文件是桌面端与本插件共用的，
  不写回就等于把用户踢下线（见上面那一节）。加新族时**默认按只读处理**，
  只有确实证明了「不写回会破坏对方」才开写回，并且必须带 CAS 基准。
- **「读不出来」不等于「空」**。这一条来自 magpie 的三次真实事故（它的 `LESSONS.md` 第 9 条）：
  `readLogins` 解析出错时返回空表，于是下一次 add / sign-out 就把「没有账号」**写了回去**。
  本仓的判定是——**只要那个「空」会流向一次写盘，就必须区分「没有」与「读不出来」**。落在四处：

  | 位置 | 过去的样子 | 现在的样子 |
  |---|---|---|
  | `store.nextAccountId()` | 只问 `list()`；payload 读不出来的号不在里面 ⇒ 被判成「空闲」，新账号 `write()` 上去**整条覆盖** | 读不出来的号**占住**，宁可对外少显示一个账号 |
  | `api` 的 `toggle` / `proxy` | `{ ...current, disabled }`：记录在 `locate()` 到 `update()` 之间被删掉时写出一条**只剩一个字段**的半截账号 | 走 `amend()`，记录不在就**什么都不写**并报 `NOT_FOUND` |
  | `minimax.readDesktop()` | 读不懂就是 `undefined`，与「没装」同形 | 三态 `ok` / `missing` / `unreadable`；读不懂时**拒绝刷新**（刷新令牌一次性，刷了写不回去等于把桌面端踢下线） |
  | `grok.writeBackAuth()` | 没有指纹基准时**跳过 CAS 直接写**（DSH 重启后就是这情形） | 退到**内容比对**：磁盘上那条记录的 `refresh` 必须还是我们这次拿去刷新的那一个，说不清就不写 |

  唯一的例外写在代码注释里：`src/discover.js` 的 `exists()` **故意**把「不知道」说成「不在」——
  它只用来给未实现族挂一句提示，不流向写盘，少说一句比对着读不动的路径宣称「你装过」好。
  **别的地方不许照抄这个取舍。** 回归测试在 `test/unknown-not-empty.test.js`（另加
  `test/minimax.test.js`、`test/grok.test.js` 里的六条），每条都验证过「改回旧实现就会失败」。

## 族的状态与取舍

| 族 | route | 状态 |
|---|---|---|
| `codex` | `acct-codex` | ✅ 真机验证 |
| `claude` | `acct-claude` | ✅ 路由真机验证；**真实推理待有订阅账号后验** |
| `agy` | `acct-agy` | ✅ 真机验证（驱动本机 `agy` CLI，14 个模型，真机推理通过） |
| `minimax` | `acct-minimax` | ✅ 真机推理通过 |
| `generic` | `acct-generic` | ✅ 真机验证（对着一个假端点两条方言各跑通一次） |
| `qoder` | `acct-qoder` | ⚠️ 单测通过，**真机未验**（本机没装 Qoder、没有 PAT） |
| `workbuddy` | `acct-workbuddy` | ⚠️ 单测通过，**真机仅验到第一条**（本机凭据是 5.6 的密文，解不开） |
| `commandcode` | `acct-commandcode` | ⚠️ 单测通过，**真机未验**（本机没有 CommandCode 账号） |
| `grok` | `acct-grok` | ⚠️ 单测通过，**真机未验**（本机没装 Grok CLI，也没有订阅） |
| `copilot` | `acct-copilot` | ⚠️ 单测通过，**真机零验证**（本机没有 Copilot 订阅） |
| `trae` | `acct-trae` | ⚠️ 单测通过，**真机零验证**（本机没有任何 Trae 账号） |

**明确不做的族，以及为什么**：

- **`kimi`（Kimi Code 订阅）**——宿主内置的 `@earendil-works/pi-ai` 已经带了 `kimi-coding` OAuth
  provider（`dist/auth/oauth/kimi-coding.js`，`https://auth.kimi.com` → `https://api.kimi.com/coding`），
  本插件再写一份只是把同一件事做第二遍。**不做。**
- **`cursor`**——计划书 §4.1 判据 C4 明确排除：Cursor 员工已公开认定这类接入违反其 ToS §1.5。
- **`zcode`**——按用户决定砍掉。

**关于 `grok` 与 `copilot` 的一句实话**：宿主内置也已经有 `xai` 与 `github-copilot` 两个 OAuth provider
（`dist/auth/oauth/xai.js` 用的 client_id 就是 `b1a00492-073a-47ea-816f-4c329264a828`）。
这两个族的价值**不是**「补一个宿主没有的格子」，而是把同一份登录态**纳入统一账号池**：
多账号、冷却、按账号出口代理、额度面板、与其它族一致的失败分类。
**只要单账号够用，就直接用宿主内置那个，不必装本插件。**

**`copilot` 族还有两句必须一起说**：

- 它打的 `/copilot_internal/v2/token` 是 GitHub **自己声明为 non-public、unstable** 的接口，
  没有任何兼容性承诺，**随时可能整体失效**（族里 `risk: 'high'` 就是这个原因）。
  V1ki 的实现里也有一句同样的注释。
- 它**没有额度接口**——所以面板上这一族永远显示「额度 未知」，
  这不是没做，是上游根本没有可读的额度。按 §C3，读不到就报未知，**绝不编 0%**。

**`trae` 族砍掉了三样东西**（都是明面取舍，不是偷偷跳过）：

- **不做凭据写回**。Trae 的 `storage.json` 是密文，而公开的参考实现里**只有解密方向**，
  没有加密方向的任何实现或抓包。自己拼一个加密器去覆盖用户的 Trae IDE 登录态文件，
  写坏了就是用户被登出、而我们连写坏了都发现不了；何况 Trae IDE 自己也在拿同一个
  refresh token 刷。所以这一族 `externallyOwned: true`（诚实标记源头在客户端里），
  但刷新结果**只写我们自己的凭据记录**。代价是用久了要重新导入一次。
- **不做签到**。它是这一族唯一会**改变账号状态**的动作，而 `9074` 是账号级稳定拒绝
  （换 deviceId / UA / token 都无效）。只保留纯查询的 `quota()`。
- **不声明推理档位、图片、工具能力**——没有证据就不声明（契约 §5.3）。

## 未定事项

- LICENSE：尚未添加（社区 DSH 插件惯例是 MIT，但加之前需要作者确认——不加就等于保留所有权利）。
- 第三档族（codebuddy / cline / opencode / kiro / devin / factory / zhipu / qwen / mimo / sensenova / longcat）：
  在 `src/discover.js` 的 `UNSHIPPED_SITES` 机制里留着位置，尚未实现。详见计划书 §4.2。
