# dsh-account-bridge

把**账号级**上游订阅（ChatGPT/Codex、Antigravity、Claude、WorkBuddy、Qoder、CommandCode…）
统一桥接进 DeepSeek Harness 的插件：一个插件、一份账号表、一套调度，而不是每家用一个插件。

> 状态：**P6 完成**——骨架 + 11 个族（`codex` / `claude` / `agy` / `minimax` / `qoder` /
> `workbuddy` / `commandcode` / `grok` / `copilot` / `trae` / `generic`）+ 本机账号统一发现 +
> 设置页账号池面板 + `/pool` 命令族。11 条 route 已在真实 DSH 宿主里验证可见
> （provider / 模型目录 / 登录流 / 工具面 / 面板数据面），route 互不撞车。
> **真机跑通过推理的族**：`agy`、`minimax`、`generic`。其余族**没有可用的真账号**，
> 属于「真机未验」，逐族的取舍见下面的「族的状态与取舍」。
>
> 当前进行中：**P7 深度改进**（见 `dsh-account-bridge-深度改进计划书.md`）——修「对上游不诚实」
> 与「账号选得不对」这两类问题，11 个工作包，**W0–W11 全部完成**。
>
> 测试：**只有端到端测试**（`test/e2e/`，起假上游 + 起真的无头宿主），
> 单元测试与回归测试都已删除；规矩写在 [AGENTS.md](AGENTS.md)。
>
> 许可：**MIT**。借用的上游代码逐条记在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，
> 并由 `test/e2e/preflight.mjs` 的静态检查强制（借了没在自己文件头注明来源就会红）。

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
| 本机 Codex CLI 登录态发现与导入（`~/.codex/auth.json`） | ✅ 真机（含 API-key 模式如实报「不可导入」） |
| 本机 Claude Code 登录态发现与导入（`~/.claude/.credentials.json`） | ✅ 真机（本机无该文件，如实返回空） |
| 驱动本机 `agy` CLI 推理（NDJSON 流 → DSH chunk，含 usage 与失败归类） | ✅ 真机推理通过 |
| 本机 agy 登录探测与导入（`agy models` 探针 + 14 个模型的真实目录解析） | ✅ 真机验证 |
| 本机 MiniMax Code 登录态发现与导入（`~/.minimax/auth/prod/{en,cn}/mcode-public/auth.json`） | ✅ 真机验证 |
| MiniMax Code 令牌刷新 + **写回桌面端**（generation CAS，防两边互相踩） | ✅ 真机验证（对真实文件跑通，令牌每刷必换是实测事实） |
| Anthropic 线协议翻译（system 分块 / cache 断点 / tool_result 配对 / SSE 分槽累积） | ✅ 端到端（探针里那条 Anthropic 方言推理；只发 `data:` 不发 `event:` 的响应也认） |
| 把宿主交来的图片附件（`{type:'image', attachment}`）解引用成 base64 再交给翻译层 | ✅ 端到端（两种方言各一条请求形状检查）；**曾是一个真缺陷**：池子从 `ctx.get` 拿不到附件服务，于是每一张图都被静默丢掉 |
| 「翻译回显」七条：工具调用拼 JSON、零值不擦用量、截断归 `max-tokens`、思考签名一字不丢、默认不回放、两种方言的请求形状 | ✅ 端到端（假上游回脚本化的流，探针断言宿主看见的 chunk 序列） |
| 客户端版本号诚实化（查 npm registry，拿不到就用兜底常量并如实标注） | ⚠️ 只在真机请求里体现（本机没有这两家订阅，端到端探针不覆盖） |
| 账号池调度：首发实质输出前才允许换号 + 冷却表 + 退避 | ✅ 真机验证 |
| 选号排序（额度档位 / 节奏 / 被限流过的沉底） | ✅ 真机验证（fake 上游上看得到谁先上） |
| 会话亲和：按上游自报的缓存读取量决定粘不粘，四态可切 | ✅ 真机验证（关掉粘性排序就会抢走） |
| 亲和记录落盘 `$DSH_HOME/storages/account_bridge.json`，重启不失忆 | ✅ 真机验证（换一个宿主进程仍认原来的账号） |
| 把 Qoder 家族注册成 provider route（`acct-qoder`，显示名 `Qoder (China)`） | ⚠️ 端到端验到 route 与元数据；**真机推理未验**（本机没装 Qoder、没有 PAT） |
| 把 WorkBuddy 家族注册成 provider route（`acct-workbuddy`） | ⚠️ 端到端验到 route 与元数据；**真机仅验到第一条**（本机凭据是 5.6 的密文） |
| 把 CommandCode 家族注册成 provider route（`acct-commandcode`） | ⚠️ 端到端验到 route 与元数据；**真机推理未验**（本机没有 CommandCode 账号） |
| **设置页里的「账号池」面板**：看每个族的账号、起登录、导入、停用、续期、设代理、删号、查额度、扫本机 | ⚠️ 数据面真机验证（路由 / 信封 / 错误码 / 不外传凭据）；**面板本身从未在真浏览器里看过**（面板上**没有**改流量上限的控件，用 `/pool limits` 或 `account_bridge_limits`） |
| **`/pool` 命令族**：`/pool` 看池子、`/pool check` 真查额度、`/pool unfreeze` 解冻冷却中的账号 | ✅ 真机验证（在宿主里 `commands.find(undefined,'pool')` 解出并跑通全部六个输入） |
| **设置 → 模型页的行内摘要**：每张 `acct-*` provider 卡片下方一行池子状态 + 页脚一整池的汇总 | ⚠️ 端到端验到它要的那份数据（`/account-bridge/state`）；**真的在浏览器里看见**待人工确认 |
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
/pool sticky [模式]          看/切会话粘性：auto（默认）| session | turn | off
/pool sticky forget [族]     **忘掉**记着的会话亲和（不写族名就是全部）
/pool lost                   最近 8 次请求里翻译层丢掉了什么（`diagnostics` 同义）
/pool limits [族] [账号]     看每个账号的流量上限；给数字就是改（`rpm` 同义）
```

**`/pool sticky` 会解释每一次换号。** 它把最近 12 条裁决翻成人话印出来，例如
「上游缓存还在，继续用它」／「上次它只从缓存里读了不到 1024 token，不值得为它换号」／
「上次答复到现在超过 5 分钟，缓存凉了」。少了这段，用户看到的只是「它不粘了」，
而不知道该去调哪个开关。

四条设计约束：

1. **`/pool` 不发网络请求。** 它只读凭据记录与内存里的冷却表。想在对话里顺手看一眼池子
   是常事，而每一次自动查额度都是拿你的账号去碰上游的风控。
2. **`/pool check` 会把「这一族没有额度接口」和「有接口但这次没读出来」分开写。**
   两者都是「未知」，但含义不同：前者你永远等不到读数，后者值得再试一次。
3. **「忘掉」不会顺手发生。** 账号停用或删除时**只**丢掉指向那个账号的记录
   （账号 id 会回收，不清就会让下次登录继承上一段会话的粘性）；要把一整族忘干净，
   必须由人明说（`/pool sticky forget` 或面板上的「忘掉」）。
4. **解冻那条命令会解释它为什么安全。** 冷却表是纯内存的派生状态，清掉最坏结果是
   下次再撞一次同样的失败、再记一条。不说清楚，人不敢用，账号就一直冻着——那才是真损失。

`/pool unfreeze codex-1` 会被认出来（`codex-1` 看起来是账号 id，不是族），并直接告诉你正确写法
是 `/pool unfreeze codex codex-1`。

命令面走宿主自己的 `ctx.commands.register()`，**不产生模型消息、不进模型历史**，所以问一句不烧额度。

## 配置项（`cordis.patch.yml` 里那一行的 `config:`）

| 键 | 默认 | 说明 |
|---|---|---|
| `families` | 全部 | 只启用列出的族 |
| `affinity` | `auto` | 会话粘性四态，见「设计要点」 |
| `affinityDebounceMs` | `2000` | 亲和记录攒多久落一次盘；只影响写入频率 |
| `replay` | `false` | 把上游的思考签名 / 加密思考块在下一轮带回去。**默认关**，理由与两条线的差别见「设计要点」 |
| `maxRpm` / `maxConcurrency` | `0`（不限） | 全局流量闸门：每个账号**一分钟内最多发出几次**请求 / **同时在外最多几个**。`0` 表示不限。也能只给某一个账号配（`/pool limits`、`account_bridge_limits` 工具、或面板那个 HTTP 面），优先级是账号级 > 族级 > 这个全局值。**只在某一家的风控会因为你发太快而拒绝时才要配**，理由见「设计要点」 |
| `holdLongestMs` / `holdThinkingMs` / `holdMostBytes` | 见 `src/pool.js` | 换号窗口的三个上限。上游特别慢（首字节要等 20 秒以上）时把 `holdLongestMs` 调长 |
| `discoverOnStartup` | `true` | 启动时后台扫一遍本机客户端登录态（只打日志，不导入任何东西）。关掉它的理由是 `agy` 族的探测要起一次子进程 |
| `claudeClientVersion` / `codexClientVersion` | 自动 | 冒充的上游 CLI 版本；留空则查 npm 最新，查不到用兜底常量并如实标注 |
| `agyBin` / `agyWorkdir` | PATH / 进程 cwd | agy 族的 CLI 位置与工作目录 |

改完不用重启整个 DSH：`/pool sticky` 与面板上的开关改的是**这一次运行**，
持久值仍然在这个文件里。

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
基准恒为 0、文件里是 16 ⇒ CAS 永远不匹配、永远静默不写。当时的单元测试没抓住，是因为它自己
贴心地传了和文件一致的 generation（**这正是本仓现在不留单元测试的原因之一**）。
真机跑完的表现是：推理成功、记录里的令牌也换了，
**桌面端的文件纹丝不动**——服务端那条令牌已经作废。最后本机三个令牌（文件里的、探针备份里的、
记录里的）全部 `invalid_grant`，只能重新登录。

那次之后加了两道闸：

- **读不到桌面端凭据就根本不刷。** 写不回去的刷新等于单方面把用户踢下线，而且不可逆，
  所以宁可报 `AUTH` 让账号进冷却并提示「先打开 MiniMax Code 让它自己刷一轮」。
  代码里那条守卫在 `src/families/minimax.js`（`readDesktop()` 读不出来就抛 AUTH）。
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
  select.js           选哪个账号先上（档位 / 额度节奏 / 沉底；纯函数，来自 magpie）
  affinity.js         会话亲和：按上游自报的缓存读取量决定粘不粘 + 落进 storageDomain
  login/
    loopback.js       PKCE + 回环回调服务器
    broker.js         「拿到 URL」与「登录完成」解耦
  wire/
    sse.js            SSE 解析
    responses.js      DSH 消息 ↔ OpenAI Responses API（Codex）
    anthropic.js      DSH 消息 ↔ Anthropic Messages API（Claude / MiniMax Code / 通用族）
    chat-completions.js  DSH 消息 ↔ OpenAI Chat Completions API（通用族）
    agy.js            agy NDJSON ↔ DSH chunk（纯函数，用真实抓包做夹具）
    replay.js         上游要求「带回来」的协议状态（思考签名 / encrypted_content）
    qoder.js          Qoder 私有信封 + COSY 签名 + WAF body 编码（纯函数）
    workbuddy.js      WorkBuddy 私有层（信包、身份模仿头、额度三态）
    commandcode.js    CommandCode 三传输协商（cli / provider-chat / provider-messages）
    grok.js           Grok Responses 线（两个计费口径的端点评址 + 指纹头）
    copilot.js        Copilot 设备码 + editor-version 炸弹 + 目录映射
    trae.js           Trae 私有信封 + 私有 SSE + Electron 存储解密（只解不加密）
    http-error.js     共享的 HTTP 失败归类（AUTH / QUOTA / TIMEOUT / …→ LlmError）
    failure-words.js  失败词表：同一个 429 的两条路说同一句话（见「设计要点」）
    diagnostics.js    翻译层的结构化诊断（只上报不抛错，有界、去噪、去重）
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
  e2e/
    harness.mjs       端到端编排：起假上游、起真的无头宿主、建临时 profile、收摊
    mock-upstream.mjs 假上游（**故意难伺候的验收台**；不许为了让自己那关过而改宽容）
    preflight.mjs     四条静态前置检查（源码规矩、署名台账、写盘面、宿主红线）
    e2e.test.js       唯一的测试文件：把探针报告翻译成测试结果
    probe/            仓内探针：在真宿主里造账号、发真请求、断言宿主看见的那份东西
docs/
  family-contract.md  「怎么加一个族」的完整规格——**想加族就先读这一份**
  host-writes.md      **真要写宿主配置之前先读这一份**：四条红线、要避开的 6 个 row id
```

> `docs/host-writes.md` 记的是「将来若去写 `~/.dsh/profiles/*/cordis.patch.yml` 必须怎么做」：
> 那份文件是**多主**的（magpie 也在写，它自己的 `dshWrites` 锁只防它自己的进程），
> 整份重写会把别人的行盖掉。**今天本仓一个字节都不写它**，
> `test/e2e/preflight.mjs` 里那条「会写盘的源码只准是哪两个文件」看着这条线。

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
（这条原先由 `test/identity.test.js` 扫整个请求守着，那份测试随单元测试一起删了；
动身份那几行时请自己核一遍：同账号幂等、跨账号不同、裸会话 id 不许出现。）

> 另外，`CLAUDE_CODE_IDENTITY` 里原本有一句
> "…running within the DeepSeek Harness account bridge."——那等于在第一段 system 里主动
> 告诉上游「这不是 Claude Code，是一个第三方桥」。已改为与官方客户端逐字一致的措辞，
> 并有测试钉住「system 里不许出现 bridge / harness」。

## 五条真机/源码才暴露的契约

> 这五条原先各有一条回归测试钉着，那些测试随单元测试一起删了（见 [AGENTS.md](AGENTS.md)）。
> 事实仍然成立，但**现在没有自动守卫**——改到相关那几行时请对着这一节自己核。

1. **适配器是鸭子类型，但少一个方法就当场注册失败。**
   `registerAdapter` 在注册时**无条件**调用 `adapter.providerRetryPolicy(provider)`；
   `?? resolveRetryPolicy(...)` 只兜返回值，兜不住「方法不存在」，于是报
   `adapter.providerRetryPolicy is not a function`。运行时真正会调用的适配器方法恰有 7 个：
   `providerInfo` / `providerRetryPolicy` / `imageRequestPricing` / `listModels` / `resolveModel` / `prepareCall` / `stream`。
   → 现在没有自动守卫；加一个新的适配器方法之前，先数一遍上面这 7 个是怎么用的。

2. **插件不能按裸模块名 import `@deepseek-ai/*` 核心包。**
   profile 的 `node_modules` 是 pnpm 扁平布局，`@deepseek-ai/` 下只有 `cosmokit` 与 `schemastery`；
   核心包只存在于 `app.asar` 里，**只能经 `ctx` 服务访问**。实测报
   `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'`。
   需要核心能力时的两条正路：① 经 `ctx` 服务；② 库内自足实现（本插件的工具定义就是自己拼的）。
   → `test/e2e/preflight.mjs` 的静态检查拦这条。

3. **`finish.reason.kind` 只认三个值：`'stop' | 'tool-calls' | 'max-tokens'`。**
   写别的（比如 `'success'` / `'tool-use'`）不会报错，但语义**静默丢失**——宿主拿不到
   「这轮是工具调用」就不会续跑，拿不到 `'max-tokens'` 就不会做截断处理。
   → 端到端探针里的「思考不算输出」那条会顺便验到收尾是否合理；六个 `stop_reason` 的映射
   在 `src/wire/anthropic.js` 的 `finishKind()` 里，改它时请把六种都过一遍。

4. **`readSse` 在没有 `event:` 行时会填 SSE 的默认事件名 `'message'`，而不是 `undefined`。**
   于是 `translateAnthropicStream` 里 `event.event ?? payload.type` 里的 `??` 是**永远走不到的死代码**
   ——Anthropic 的事件名里没有叫 `message` 的，`event.event` 恒为真。而自建中转只发 `data:`
   是常态（把事件名写在 `payload.type` 里）。现在按 `'message' | undefined` 显式回退。
   → 假上游（`test/e2e/mock-upstream.mjs`）的 Anthropic 那条路**只发 `data:` 不发 `event:`**，
   端到端每轮都在演这件事；守卫就在这里。

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
   → 见 `src/failure.js` 与 `src/wire/http-error.js`（那个把宿主算法**复刻**出来、
   逐条断言我们的错误真能过它的用例原先在 `test/failure.test.js`，随单元测试一起删了）。

## 独立审查（P7.5）：四个互不通气的审查员

P7 十一个工作包做完之后，**四个独立子代理**分头读了一遍代码——各读各的、互不通气、事先不知道对方在看什么，每份结论都要求带 `文件:行号` 与可复现的合成输入：

| 审查面 | 报告 | 抓到的东西 |
|---|---|---|
| 池子与账号决策 | `_dsh_research/review/core-pool.md` | 2 严重 + 5 次要 |
| 协议翻译层 | `_dsh_research/review/wire-protocol.md` | 4 严重 + 7 次要（含一个能复现的假上游脚本） |
| 十一个族 | `_dsh_research/review/families.md` | 2 严重 + 6 次要 |
| HTTP/UI/工具面 | `_dsh_research/review/surface.md` | 2 严重 + 7 次要 |

**这一轮修掉的十处**（当时每处都配了回归用例；那些用例随单元测试一起删了，
所以下面这些**现在只有代码里的注释与这份清单记着**，动到相关代码时请对着核）：

1. **额度失败停错了范围**（`src/health.js`）：`MODEL_SCOPED_QUOTA_FAMILIES` 里写的是 `'antigravity'`，而族的 id 是 **`agy`**——集合里那个名字从来不存在，于是「这个模型额度用尽」被当成「这个账号废了」，把整个账号停掉、连带把别的模型也停了。现在集合里是真实族 id，并加了一条不变量用例：集合里的每个名字都必须是 `FAMILIES` 里真的有的 id。
2. **`?? 兜不住 0`**（`src/families/codex.js`、`src/families/claude.js`）：上游把 `context_window` 回成 `0` 时，`?? 默认值` 放它过去，宿主拿到 `contextWindow: 0` 会判 `INVALID_MODEL_CONTEXT` 并把整个 provider 连坐。改用 `firstPositiveNumber()`。
3. **回环回调的 state 可以被绕过**（`src/login/loopback.js`）：`result.state !== undefined && result.state !== expected` 这个写法把「回调根本没带 state」当成匹配——本机任何实体都能用 `GET /callback?code=<自己的码>` 塞一个授权码进来。现在是严格相等。
4. **回环数据面只认 `remoteAddress`**（`src/api.js`）：DNS rebinding 下浏览器的请求也来自 `127.0.0.1`，于是 `state` / `remove` / `unfreeze` / `proxy` 对任意网页可达。现在多一道 `Origin` 检查（**没有 Origin 的放行**——`curl` 不该被挡；`Origin: null` 拒绝）。
5. **零参工具调用会被整条丢弃**（`src/wire/chat-completions.js`）：先发了一个合法的 `tool-call` 块，随后按「一个字都没出」抛 `EMPTY_RESPONSE`。判据改成「有名字也算交付」。
6. **`response.output_item.done` 不带 `output_index` 时块关不上**（`src/wire/responses.js`）：补开一个空块收尾，不置「已输出」。
7. **Anthropic 流里 delta 先于 `content_block_start` 到达**（`src/wire/anthropic.js`）：新增幂等的 `ensureStart()`，delta 前补开块；`content_block_stop` 只关真开过的块（否则悬空/重复关都会让宿主整条流判失败）。
8. **grok 写回的两道 CAS 基准不同源**（`src/families/grok.js`）：`rememberHash()` 记的是磁盘原文，比对用的却是规范化 JSON——只要用户的 `auth.json` 不是「两空格缩进 + 结尾换行」，第一道 CAS **每次都判 stale**，写回被静默跳过，而理由被记成「别的进程改过文件」，排障方向完全是错的。
9. **agy 把「问不到」当成「空目录」**（`src/families/agy.js`）：CLI 超时/非零退出时 `probe.signedIn=false`，`listModels()` 于是老老实实回 `[]`，池子把这份**假空目录**缓存十分钟——面板会说「没有账号提供 X」，一句我们并不知道真假的话。现在探测结果带 `unknown`，`listModels()` 抛出 `TRANSPORT`（瞬态、不罚账号、下次再问），扫描结果也照实说「这次没问出登录状态」而不是「还没登录」。
10. **`assertApiReply` 会把正文读空再还回去**（`src/wire/assert-reply.js`）：非 2xx 且 `content-type: text/html` 时它读整个 body 嗅探，看走眼之后**原样返回一份已经读空的响应**——五个调用点都写着 `.catch(() => '')`，上游到底说了什么就永久丢了，排障时只看到一句「没原因」的 403。现在把读到的内容装回一份等价物。

**这一轮没修、记在计划书里的**：闸门让位时会把冷却中的账号排到前面、`/pool sticky` 的 `full` 判据偏弱、`COOLING` 落进失败归类兜底、`gate.js` 的 rpm 队列在限额调大后不再升序、透明代理配置错误时静默直连、`account_bridge_accounts_remove` 漏了清健康/粘性状态、`discover` 把「读不出来」当成「不在本机」等十余条次要项（见《深度改进计划书》§P7.5 遗留）。

## 测试

**这个仓库只有端到端测试。** 单元测试与回归测试都删掉了，只留真机链路测试——理由与代价写在
`AGENTS.md`：「我以为的协议是自洽的」不是证据，而这个插件几乎每一条规矩都是从真机上撞出来的。

```bash
npm test                           # 起假上游 + 起无头真宿主，跑一轮端到端
node test/e2e/harness.mjs          # 同上，并且把宿主的输出一并转出来（查问题用）
node test/e2e/harness.mjs --quiet  # 同上，宿主输出不外泄
```

一轮 `npm test` 做四件事：

1. **四条静态前置检查**（`test/e2e/preflight.mjs`）：源码里不许按裸模块名 import 核心包；
   `THIRD_PARTY_NOTICES.md` 里登记的每个源文件必须自己注明来源；会写盘的源码只准是
   `src/families/{grok,minimax}.js`；`docs/host-writes.md` 里那六个不许碰的宿主配置 row id 还在。
   这些是「一眼能判定、错了后果很贵」的规矩，不搬任何逻辑断言。
2. 起一个**假上游**（`test/e2e/mock-upstream.mjs`，端口随机）：它是**故意难伺候的**验收台——
   Anthropic 那条路只发 `data:` 不发 `event:`、不认 `stream_options`、不认 `cache_control`、
   不认 `Claude Code` 身份块、密钥不对回 401，另有一批专演事故的模型
   （`claude-mock-hold` 先吐 20 个思考块再报错、`mock-html-page` 回一整页 HTML、
   `mock-cf-403` 回 403 的 HTML、`mock-429-week` 回带一周 `retry-after` 的 429、
   `mock-credit` 回「余额不足」）。**不许为了让自己那关过而把它改宽容。**
   它还把**收到的每一笔请求原样记下来**（`GET /__requests`，只留最近 50 笔），
   所以探针能回头质问「我这一笔到底发出去长什么样」；`mock-openai-only` 与
   `mock-anthropic-only` 两个模型各自只出现在一条方言的目录里，用来把一笔请求钉死在一条路上。
3. 起一个**真的无头宿主**（`<exe> <cli.js> --profile e2e`，`DSH_HOME` 指向 `test/e2e/.home/`），
   插件是按 `link:` 装进去的 ⇒ **改 `src/` 立刻生效，改探针要重跑**。
4. 仓内的端到端探针（`test/e2e/probe/`）等在宿主里跑 26 条检查，结果写进报告文件再由 `npm test` 读回来。

要求 Node ≥ 20 与一份 DSH 桌面版（默认 `D:\Program\deepseek harness desktop`，
可用 `DSH_DESKTOP` / `DSH_HOST_EXE` / `DSH_HOST_CLI` 覆盖）。临时 profile 建在
`test/e2e/.home/`（已 gitignore）：**第一次要装 200 多个包、半分钟左右**，之后就走缓存。

**加测试 ＝ 加一条检查。** 检查写在探针里（`test/e2e/probe/index.js`），套路固定：
用 `account_bridge_*` 工具造出需要的账号 → 让池子真的发一次请求 → 断言宿主看见的那份东西
（chunk 序列、`finish.reason.kind`、`failure.code`、数据面返回的字段）。断言要写在探针里、
**不要**挪到 `e2e.test.js`——那里只负责把报告翻译成测试结果，一行判断都不要有。

**「翻译回显」这一组检查是替代品**：单元测试时代有一套 golden 快照，逐字节钉住 12 个翻译器
的请求体与 chunk 序列。那套快照随单元测试删了，现在由七条真机检查接着守同一件事——
假上游回**脚本化的流**，探针断言宿主最终看见的 chunk 序列：

| 检查 | 假上游演什么 | 断言什么 |
| --- | --- | --- |
| 工具调用 | `mock-tool-call` 分三片吐 `input_json_delta` / `tool_calls` 增量 | 宿主拿到**一个** `tool-call` 块，`arguments` 是拼好的 JSON 字符串，收尾是 `tool-calls` |
| 用量不擦零 | `mock-usage-zero` 先报 4242，再报一帧全零 | 最后一帧的零**没有**把 4242 擦成 0 |
| 截断 | `mock-cut-short` 用 `finish_reason:'length'`（Anthropic 那边是 `pause_turn`） | 收尾是 `max-tokens`，不是 `stop` |
| 签名不丢 | `mock-signed-thinking` 分两片吐 `signature_delta` | `finish.replayState` 里那个签名一个字符不少 |
| 默认不回放 | `mock-anthropic-only` | 发出去的请求里**有**上一轮的话、**没有**上一轮的思考与签名 |
| 请求形状 ×2 | 两种方言各一条 | system、工具定义、图片 data URL / image 块、`tool_result` 配对、`max_tokens`、`stream_options` 各自该长成什么样 |

两条老实话：端到端能证明「接上去是对的」，证明不了「我不知道的那条规则有没有被改动」；
上面那七条检查覆盖的是**已经被撞见过**的那部分规则面，没撞见过的规则仍然没有守卫。

## 设计要点

- **静态 `inject` 恒为空数组**，一律用惰性 `ctx.inject([...], cb)`：静态注入一个该 composition
  里不存在的服务会让 entry 永久 pending，而 loader 把 pending 当 **profile 加载失败**。
- **族与池子拿宿主服务只有一条路：`ctx.get(name)`**（`ctx` 就是 `src/index.js` 里那个
  `familyContext`，它的 `get` 是 `serviceOf(ctx, name)` 的惰性转发）。**真机验收抓到过这条的代价**：
  `familyContext` 原先是个没有 `get` 的普通对象，于是 `ctx.get?.('attachments')` 恒为 undefined，
  每一张图片都原样带着引用进翻译层、被当成「没有数据的图片」丢掉——翻译层照旧报诊断、
  套件照旧全绿，只有真宿主里那张图从来没到过上游。同一条路还静默废掉了 CommandCode 族
  四源凭据里的第一源（`credentials` 服务）。**加新服务时先确认 `serviceOf` 认得它**。
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
- **上游要求「带回来」的那点东西，我们不再扔**（`src/wire/replay.js`）。Anthropic 开了
  extended thinking 之后，**带签名的思考块必须完整未修改地出现在下一轮的助手轮里**：不发，
  要么 400，要么助手轮从 `tool_use` 开头——一个「不带思考的工具调用」，那正是它拒收的形状。
  Responses 线要的是 `encrypted_content`。宿主为这件事留了一个对适配器不透明的口袋：
  `finish` 块可以带 `replayState`，它原样存进 `message.source.replayState` 并持久化。
  这一条有几个只有读宿主源码才知道的坑：

  | 事实 | 后果 |
  |---|---|
  | `assembled()` 拿 `envelope.blocks.length` 与**它自己见过的块数**对一下，对不上就**整个信封丢掉** | `blocks` 必须与流里**出现过的**块一一对齐，而且是「见过的顺序」不是「留下的顺序」——`max-tokens` 会丢掉工具调用块，那时宿主**按同样的位置**过滤信封，我们照样得为被丢掉的块留一个占位 |
  | 我们 11 条 route **共用同一个 adapter 对象**，`forAdapter()` 因此不会替我们把 codex 写的信封挡在 claude 前面 | `kind` 必须自己查；两个线种的字段名也刻意不同（`signature` / `encryptedContent`），免得「读错族的信封」在 kind 检查之外还有第二条路 |
  | 签名是**某一个账号**签的 | 回放只给**第一个**候选（`replay: this.#replay && index === 0`）。换号之后把上一家签的东西发给下一家，是既没验过也不该发生的事——上游会拒，而我们无从分辨那是「格式不对」还是「这不是你签的」 |
  | **读不懂就是没有**，绝不抛错 | 版本不认识、模型换了、块数不齐、类型对不上——统统一声不响地降级成「不带这个状态」。宁可让上游重新生成一次思考，也不要拿一个可疑的东西去换一个 400 |

  **默认关，而且是有理由的关**：跨账号能不能用另一个账号签发的思考块，我们没验过（本机没有
  这两家的订阅）。关着的时候签名照旧一个字符都不会丢，只是下一轮不往回发；两条线的口径不完全
  一样，是因为它们拿到状态的方式不一样——Anthropic 的 `signature_delta` **不管你要不要都会发**
  （所以攒着是白送的），Responses 的 `encrypted_content` **得先在请求里 `include` 才会给**
  （所以不开回放就不去要，免得改动了默认请求）。`config.replay: true` 两半一起打开。
- **「谁先上」不是 id 顺序，而是「谁最撑得住 + 谁最近被打得最少」**（`src/select.js`，语义借自
  magpie，见 `THIRD_PARTY_NOTICES.md`）。旧写法是
  `ready.sort((a, b) => a.account.id.localeCompare(b.account.id))`：所有请求压在字典序第一个
  账号上，直到它被限流为止——注释写着「按负载摊开」，代码从来没摊开过。判据按顺序是：

  | 判据 | 说明 |
  |---|---|
  | `learns` | 额度**未知**、而这一族又读得出额度的账号，先答一次。否则它永远排在已知账号后面，也就永远不会被知道 |
  | 档位 | 用掉 ≥98% 一档、≥90% 一档、其余一档；**同档内**才比后面的 |
  | 剩余额度撑多久 | `(100 - 已用) / max(重置时刻 - 现在, 1 小时)`，取最紧的那个窗口。分母那 1 小时下限是必须的：不然「马上重置」会把它顶到无穷大 |
  | 重置时刻 | **截断到小时**再比。差几分钟就重排会让账号在两次请求之间来回抖 |
  | 近期用量 | 请求数按 1 小时半衰期衰减，把并列的账号摊开 |
  | id | 只为确定性，**不再决定谁先上** |

  **「pace 相差一档以内算同档」必须先离散成整数层再排序**：`p < 0.9 × top` 不传递，
  三个各差一档不到的 pace 直接塞进比较器会**绕圈**（a>b>c>a，结果取决于输入顺序）。
  magpie 的源码注释专门写了这件事；`src/select.js` 的 `bandOf()` 就是把它离散成整数层，
  改它之前请先用四种不同的输入顺序各想一遍。
- **被限流过的账号会「沉」到后面**（`src/select.js` 的 `sinkOrder`，magpie 的 Sink）。
  一个账号被限流、冷却一结束就又被灌满请求，正是厂商风控会盯上的形状（那条需求来自 magpie
  用户 01huadalang 的实际投诉）。沉过的排在没沉过的后面、**沉得早的排在沉得晚的前面**，
  只有排在它前面的也都被限流过才回到最前——负载于是绕着账号走，而不是每次都回到第一个。
  **只有限流会沉**：额度用尽与欠费是「它现在不能用」，不是我们打得太急。只增不减、重启即忘，
  换代理也不清（换代理不会让「被限流过」没发生过）。
- **流量闸门默认是关的，因为「多少算太快」只有厂商知道**（`src/gate.js`，语义借自 magpie 的
  `internal/gateway/rpm.go` 与 `concurrency.go`，见 `THIRD_PARTY_NOTICES.md`）。配了
  `maxRpm` / `maxConcurrency`（或只给某个账号配）之后：① 计数的是**真的发出去的每一次请求**——
  重试、换号、以及插件自己刷模型目录的那一次都算，因为上游数的是它收到的包；
  ② **排队不等于失败**：等一个并发槽（或等这一分钟腾出位置）的请求不会被让给别的账号，
  也不会让那个账号冷却；③ 超上限**立刻**按 `Retry-After` 拒绝，**不许无限等**；
  ④ 代码是 `LOCAL_RATE_LIMIT` 而**不是** `RATE_LIMIT`——后者在本仓的意思是「上游限流了这个账号」，
  而闸门拦下的请求**包根本没出去**，罚它会把一个完全健康的账号冻起来，而且下一次照样被同一个闸门挡住；
  ⑤ 等超时或调用方走了，位置要**还回去**（没发出去的请求不该占着配额）。
  顺序也有讲究：**先拿并发槽，临发送前才等分钟余量**，否则一堆请求会握着这一分钟的名额在并发队列里干排。
  池子侧还会**让位**：装配候选时把「这一分钟已经没余量」的账号挑出来排到后面，被挪走的第一个
  如果正是粘住的那个，`/pool sticky` 上会写 `full`（否则那段会话上写着「粘住了」而实际派的是别人）。
  **真机验收（W10）**：把两个账号配成 `maxRpm: 1`、其余账号全部停用之后，单条请求等了
  **60 010 毫秒**才发出去（一分钟的窗口就是这么久），`POST /account-bridge/gate` 里那两个账号是
  `{"rpm":1,"rpmLimit":1,"laneLimit":4}`——限额确实是从**账号记录**读出来、也确实被池子用上了。
  但紧接着的八条并发请求各只花了 780 毫秒、一条都没被拦，**这一点没有解释清楚**：最可能是宿主的
  默认重试拿 `providerRetryAfterMs` 等满一分钟再发（于是「被拦」在调用方眼里变成「慢了一点」，
  而那正是我们想要的效果——把请求摊开，而不是让用户吃到失败），但也不排除那一瞬间池子认的候选不对。
  把行为钉死的是当时的单测（两个账号各 1 次/50 毫秒、八条并发，断言发出的时刻被摊开，
  且同一个账号不会在一个窗口里发两次）——**那份测试随单元测试一起删了，这条现在是未解之谜**；
  要复查就在探针里加一条同级检查，别只靠推理。
- **选号看的额度是后台尽力而为读来的**：池子装配时顺手起一次 `family.quota()`，每账号 5 分钟
  TTL、失败后隔 1 分钟才再试，**装配与选择都不为它等待**。上游返回 `undefined`（什么都没说）
  时**不写快照**——保持「未知」才能继续走 `learns`；写成 0 就等于替上游宣布「你没额度了」。
  （「额度查询不落地时请求照样跑完」这条原先有条用例守着，那份测试已随单元测试删掉。）
- **会话粘性：粘不粘由上游「到底从缓存里读了多少」说了算**（`src/affinity.js`，语义借自 magpie
  的 `internal/gateway/affinity.go`，见 `THIRD_PARTY_NOTICES.md`）。旧写法是「同一段会话无条件
  粘住」，它有个说不出口的假定：**粘住就一定省了钱**。上游若压根没缓存这一轮（换了模型、
  缓存过期、服务端把它踢了），粘住只是在把一个可能已经被限流的账号钉死在会话上。
  现在的四态（`config.affinity`）：

  | 模式 | 行为 |
  |---|---|
  | `auto`（默认） | 上一轮**从缓存里读了 ≥1024 token** 且 **答复至今不到 5 分钟** ⇒ 粘住；否则交给排序 |
  | `session` | 整段会话都粘同一个账号（旧的「无条件粘」） |
  | `turn` | 只在**同一轮**内粘（比如一轮里回传工具结果、再问一次） |
  | `off` | 不粘 |

  判据是 `usage` 里上游自报的缓存读取量（`cachedInputTokens` / `cache_read_input_tokens` /
  `cached_tokens`），**不是猜的**。粘性键是 `${族}-${sha256(模型 + 换行 + 会话 id) 前 24 位}`——
  键里带模型，因为同一段会话换模型就是另一份缓存（这一步刻意偏离 magpie）。
  **粘性只在它确实该赢的时候才推翻排序**：记录指向的账号正在冷却、或者额度已经用满 98%、
  或者已经不在候选里（被删/被停用），粘性都会让位，并把理由记下来。
  每次裁决都会留一个 `why`（`sticky-hit` / `sticky-new` / `cache-weak` / `cache-cold` /
  `resting` / `spent` / `gone` / `session` / `turn` / `sticky-miss` / `off`），
  `/pool sticky` 与面板会把它翻成人话——**「为什么这次换了账号」必须答得出来**，
  否则用户只能看到它「不粘」。
- **亲和记录落在 `ctx.storageDomain`，重启不失忆**：domain 名 `account_bridge`、表 `affinity`，
  由宿主的 `storage-json` 后端写成 `$DSH_HOME/storages/account_bridge.json`。
  不自己开文件，是因为这一份数据本来就该和宿主的存储一起被备份、被清理。
  攒 2 秒再落盘（那个后端是「整个 unit 一个 JSON 文件」，写一条就要重写一遍）；
  **写不进去时记录留在脏表里等下次，绝不假装写成功了**；读不懂的记录按「读不懂」处理
  （`invalidRecords: 'backup-and-skip'`）——当成「这段会话没有记录」会在下一次落盘时把它永久抹掉。
  收尾顺序是**先落盘再关 domain**。
- **删账号要忘掉指向它的记录，停用账号什么都不要动**。这一条是拿真机换来的：原先 `remove` 与
  「启用一个账号」都是 `clearSticky(族)`，于是探针 `finally` 里重新启用 59 个账号时，
  这一族**所有**会话的缓存亲和被清了 59 遍——现象是「`persisted` 报 true，盘上一条记录都没有」。
  现在 `remove` 只丢掉 `accountId` 指向那一个账号的记录（**账号 id 会回收**，`nextAccountId()`
  取最小空号，不清就会让下次登录继承上一段会话的粘性），`toggle` 一个字都不动——
  候选人变了不需要清，`decide()` 自己会给 `gone`。**整族清只留给用户明说要忘的那条路**
  （`/pool sticky forget` 与面板上的「忘掉」）。
- **刷新按账号合并 in-flight promise**：refresh token 通常一次性轮换，并发刷新会把账号踢下线。
  DSH 凭据记录的独占写只解决跨进程，解决不了同进程并发。
- **刷新失败同样记冷却，冷却期间不再重试刷新**。模型目录是靠刷新后的 payload 去拉的，
  刷新一失败目录就空；如果失败不进健康表，账号列表会一边说「健康」一边列出零个模型，
  而且目录不缓存失败 ⇒ 每次 `listModels` 都会再拿那条已经作废的令牌去打一次上游。
- **失败粒度是 `(族, 账号, 模型)`**：配额失败在按模型分线的族（Claude、Antigravity）只停那一格，
  其它族停整个账号；`400/422` 是请求本身的问题，**谁都不罚**。
- **停多久是算出来的，不是一个常数**。四条规则都来自 magpie（`internal/gateway/routing.go`），
  它是用事故换来的：
  1. **上游自己说的时间最多信一小时**。教训（#147）：一个 21:34 才恢复的 ChatGPT 账号，
     `resets_at` 被当成 `Retry-After` 原样照做，于是它被试、被拒、又被停——三轮都没等到真正
     恢复的那一刻。同一个上限也管额度类的 `Retry-After`。
  2. **反复失败要退避**：1 分钟起，翻倍，限流封顶 30 分钟、普通故障封顶 10 分钟。但在
     **冷却还没结束**时又失败，计数不动——magpie 的原文是「one request's own retries don't
     stretch it」；少了这条，调用方重试三次就能把一个账号从一分钟停到八分钟。冷却结束
     30 分钟之后才算新的一次（不然一个每天被限流一次的账号第二天就从十分钟起步）。
  3. **「余额不足」与「额度用尽」不是一回事**：前者等有人充钱（30 分钟、罚整个账号——没有
     余额的账号没有哪个模型是好的），后者等窗口滚回来（15 分钟、按族的粒度）。Zhipu 的
     GLM Coding Plan 用「余额不足或无可用资源包，请充值」回 429；只看状态码，那只是一次限流。
  4. **限流词先于额度词**，且只写 `reached` / `exceeded` **不算额度证据**——`Rate limit
     exceeded` 里就有（magpie #153）。反过来，一个 503 说「Rate limit exceeded」会被认成
     限流而不是「服务器炸了」：状态码说不出这两件事，但该等的时间不一样。`NOT_AN_API_REPLY`
     （拦截页）永远不会被页面上的字样改写。
  每条冷却都带一个 `by`（`policy` / `cooldown` / `backoff` / `retry-after`），
  面板与 `/pool` 靠它解释那个数字是怎么来的。
- **上面这套词表只有一份**（`src/wire/failure-words.js`）。同一个 429 会经过两条独立的路：
  `wire/http-error.js` 的 `mapStatus()` 定 `error.code`——那是**宿主与用户看得见的**码；
  `health.js` 的 `classifyFailure()` 定**停哪个号、停多久**。各写一份就会漂移，而且漂移的
  表现正是最难查的那一类。真机验收里就抓到过一次：Zhipu 的「余额不足或无可用资源包，请充值」
  让账号被按「欠费」冻了半小时，屏幕上却写着 `RATE_LIMIT`。当时有一条不变量用例逐条比对
  `error.code` 与冷却裁决必须永远一致（那份用例随单元测试一起删了；
  现在由端到端探针里两条 429 检查——`mock-credit` 与 `mock-429-week`——守着同一件事）。
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
  **别的地方不许照抄这个取舍。** 这条原先有九条用例守着（含 minimax 与 grok 各几例，
  每条都验证过「改回旧实现就会失败」），现在随单元测试一起删了——**改这四个地方之前请回来读这张表**。
- **翻译层不再静默丢东西**（`src/wire/diagnostics.js`）。协议之间做转换，总有表达不了的东西；
  过去的做法是 `default: break`——**连「丢了什么」都不说**。代价不是理论上的：`pause_turn`
  落进 `default` 让「被服务端工具暂停的一轮」看起来像正常说完了；`output_index ?? 0`
  在缺字段时关掉第 0 个块，同一段文本吐两遍；带着解析不出来的参数的工具调用被**空着参数**
  发出去，模型收到的是一个没给参数的调用。现在每个丢点都发一条结构化诊断：

  ```js
  { code, path, message, severity, phase }   // severity: 'warning' | 'error'
  ```

  `warning` = 展示层差异（模型看不到的东西、界面上少一块）；`error` = **内容或工具行为变了**。
  转换器**只上报、不抛错**——策略留给调用方。十二条码，全部有测试：`TOOL_ARGUMENTS_UNPARSABLE`、
  `TOOL_CALL_WITHOUT_NAME`、`UNKNOWN_BLOCK_TYPE`、`UNRENDERED_BLOCK_TYPE`（同一个词在请求方向
  与流方向分开，因为「模型看不到」和「用户看不到」是两件事）、`IMAGE_WITHOUT_DATA`、
  `UNHANDLED_DELTA_TYPE`、`UNKNOWN_STREAM_EVENT`、`UNRENDERED_ITEM_TYPE`、
  `UNKNOWN_STOP_REASON`、`REPLAY_STATE_MISSING`、`CONTINUATION_STATE_LOST`、`EMPTY_RESPONSE`。

  三条自律写进了代码注释：**去噪**（`response.created` 这类本来就不带内容的事件不报，
  回放关掉时跳过思考块也不报——那是用户选的）、**有界**（默认留 64 条，按 `code`+`path`
  去重合并且数 `count`）、**永不抛**（诊断自己炸了不能连累这一轮请求）。
  `Diagnostics.summary()` 给面板与日志一句人话，`hasErrors` 用来区分「只是少看见点东西」
  与「这轮结果不能信」。

  **报告要有人在听才算数。** 池子是那个人：它给每次请求开一本**独立的**账（一个坏掉的流
  不该把接下来十轮的日志都染上它的味道），把账本通过 `onDiagnostic` 交给族，一轮结束后
  `lost content: IMAGE_WITHOUT_DATA×2` 这样**只说一句**（有 `error` 级走 `warn`，否则 `info`），
  并且把账本留在内存里。调用方中途放弃（用户按了停止、宿主换了账号）
  时账本照样落地——`finally` 里收尾，那正是最需要知道「刚才丢了什么」的时刻。

  **账本留最近 8 次请求，报的是最近一次真的丢了东西的那次**，不是字面上的最后一次。
  真机验收时被这件事绊了一下：agent 一轮里有好几次请求，最后一次常常是干净的（回传工具
  结果那一轮），只留最后一次的账本就变成了「你刚看见模型没读到你的图片，去查，它说
  『什么都没丢』」。所以 `/pool lost` 说的是「最近 8 次里有 1 次丢了东西，下面是最新那一次」，
  环里从来没丢过时才说「什么都没丢」，一次请求都还没走过时说「还没有走过一次请求」——
  这三句话对应三种该做的事，不能合成一句。

  **日志那一行只是顺手，不是观测面。** 桌面版里 `ctx.logger` 写到哪由宿主决定；headless
  跑的时候它连 stdout 都不落——真机验过：同一个 logger 说一句话，日志里一个字都没有。
  所以「刚才到底丢了什么」要看的是**内存里那本账**，两个门都开着：`/pool lost` 命令，
  和 `POST /account-bridge/diagnostics`（面板走的就是后者）。

  这条链子上有一个**测试脚手架抓不到**的坑：`src/pool.js` 递给族的那一大坨 options 是
  **逐字段拼出来的，不是 `...options` 展开的**，所以 `onDiagnostic` 必须显式写进去。漏写的
  后果是「翻译层会报告、测试全绿、文档说它记下来了，而生产路径上一个人都没听见」——
  比不报告更糟。当时有两个守卫盯着（池子侧的账本用例、以及静态扫描 `src/families/*.js`
  里「调用了接受 `onDiagnostic` 的翻译函数却没传」的检查），**都随单元测试删掉了**；
  这条链子现在由端到端探针的「诊断面可用」间接看着，改 `src/pool.js` 那段 options 拼接时请特别当心。
- **翻译层丢东西时的账本留最近 8 次**：`src/pool.js` 的 `#lost` 是个 8 格环，
  `/pool lost` 报的是**最近一次真的丢了东西的那一本**（不是最后一次请求的那一本——agent 一轮里
  最后一次常常是回传工具结果的干净请求）。这条正是真机验收抓出来的：账本原先只留最后一次，
  于是事后去查永远看到「什么都没丢」。
- **golden 快照曾经存在，现在没有了**（原 `test/golden/`，五条翻译线 × 请求/流两个方向逐字节钉住）。
  W4/W8 抓到的四条缺陷**全部**属于「我不知道的那条规则也被改动了」这一类，
  而那正是当时用快照的理由——**删掉它是这次「只留端到端」付出的最实的一笔代价**。
  端到端能证明接上去是对的，证明不了这个。要重建的话，最低成本的做法是在假上游里加一个模型，
  把某条翻译线上的请求/流原样回显出来，再由探针比对。

## 族的状态与取舍

| 族 | route | 状态 |
|---|---|---|
| `codex` | `acct-codex` | ✅ 真机验证 |
| `claude` | `acct-claude` | ✅ 路由真机验证；**真实推理待有订阅账号后验** |
| `agy` | `acct-agy` | ✅ 真机验证（驱动本机 `agy` CLI，14 个模型，真机推理通过） |
| `minimax` | `acct-minimax` | ✅ 真机推理通过 |
| `generic` | `acct-generic` | ✅ 真机验证（对着一个假端点两条方言各跑通一次） |
| `qoder` | `acct-qoder` | ⚠️ 端到端验到 route 与元数据；**真机推理未验**（本机没装 Qoder、没有 PAT） |
| `workbuddy` | `acct-workbuddy` | ⚠️ 端到端验到 route 与元数据；**真机仅验到第一条**（本机凭据是 5.6 的密文，解不开） |
| `commandcode` | `acct-commandcode` | ⚠️ 端到端验到 route 与元数据；**真机推理未验**（本机没有 CommandCode 账号） |
| `grok` | `acct-grok` | ⚠️ 端到端验到 route 与元数据；**真机推理未验**（本机没装 Grok CLI，也没有订阅） |
| `copilot` | `acct-copilot` | ⚠️ 端到端验到 route 与元数据；**真机零验证**（本机没有 Copilot 订阅） |
| `trae` | `acct-trae` | ⚠️ 端到端验到 route 与元数据；**真机零验证**（本机没有任何 Trae 账号） |

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
