# 第三方代码与许可

本仓采用 **MIT**（见 [LICENSE](LICENSE)）。本文件记录**借鉴了哪些上游代码、以什么许可借的、用在哪里**。

## 规则（写代码前先读）

1. **只借鉴 MIT / Apache-2.0 的代码。** 本仓不引入 AGPL 代码——AGPL-3.0 第 13 条要求「修改后支持远程网络交互的程序必须向所有远程交互用户提供完整对应源码」，而本插件跑在有 Web GUI 的 DSH 里，一旦引入就等于整个插件改许可并背上源码提供义务。
2. **每个借用了代码的源文件，头部必须有一行来源注释**，指向本文件的对应条目：

   ```js
   // Hold-window constants adapted from magpie internal/gateway/fallback.go
   // (MIT, Copyright (c) 2026 yetone). See THIRD_PARTY_NOTICES.md.
   ```

3. **说清「改了什么」。** Apache-2.0 明确要求标注修改；MIT 虽未要求，但我们一律照做。Go/TypeScript → JavaScript 的**重写仍然是衍生作品**，许可照常适用。
4. **抄之前先查来源文件本身有没有夹带。** 尤其是 AstrLink：它自有源码是 Apache-2.0，但 Core 链接了 AGPL 的 RelayKit，`LICENSING.md` 明写不授予链接例外。**判定动作：`grep -l relaykit <文件> 及它 import 的本地包`——命中就不抄。**
5. **只学规格、不抄代码也是合法的**（事实性规则、常量名、字段名、字段位置不受版权保护）。RelayKit 走的就是这条路。

## 上游许可核实结果（逐个读过原文）

| 项目 | 许可 | 核实位置 |
|---|---|---|
| [yetone/magpie](https://github.com/yetone/magpie) | **MIT**，`Copyright (c) 2026 yetone` | `LICENSE` 首行 `MIT License` |
| [Calcium-Ion/AstrLink](https://github.com/Calcium-Ion/AstrLink) | 自有源码 **Apache-2.0**；链接的 RelayKit 为 **AGPL-3.0** | `LICENSE` = Apache License 2.0；`LICENSING.md` 有专章说明 |
| [V1ki/dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions) | **MIT**，`Copyright (c) 2026 V1ki` | `LICENSE` 首行 `MIT License`；`package.json` `"license": "MIT"` |
| [QuantumNous/new-api](https://github.com/QuantumNous/new-api)（含 `relaykit/`） | **AGPL-3.0** | 根 `LICENSE` 首行 `GNU AFFERO GENERAL PUBLIC LICENSE Version 3`；`relaykit/README.md` 明示跟随根许可 |

## 借用的代码

> 每落地一个工作包，就把对应的行从下面「计划借用」移到本节。
> **本节每一条都会被 `test/notices.test.js` 强制**：路径必须存在、文件头部必须注明来源。

### AstrLink（Apache-2.0，Copyright Calcium-Ion）

来源：<https://github.com/Calcium-Ion/AstrLink>，基线提交 `5ceced5`。

| 上游文件 | 用在本仓 | 内容 | 修改 |
|---|---|---|---|
| `core/internal/accountauth/claude_identity.go` | `src/wire/identity.js`、`src/families/claude.js`、`src/families/codex.js`、`src/families/grok.js` | 会话标识按账号分命名空间（`sha256` 派生后置成 UUIDv4 形状）、每个账号一个稳定设备标识、`metadata.user_id` 的两种形态、「身份成套铺」的清理顺序 | Go → JS 重写。**改了两处**：① 命名空间由「上游服务 id」改为「族 + 本插件的账号 id」（我们的账号 id 才是区分同族两个账号的东西）；② 新增 `accountScopedSession` 作为三个族共用的唯一入口，避免身份头 / `metadata.user_id` / `prompt_cache_key` 三处各自派生。**该文件不链接 RelayKit**，已核对（`grep -l relaykit` 无命中）。 |

### magpie（MIT，Copyright (c) 2026 yetone）

来源：<https://github.com/yetone/magpie>，基线提交 `d7a1b02`。

| 上游文件 | 用在本仓 | 内容 | 修改 |
|---|---|---|---|
| `internal/gateway/notapi.go` | `src/wire/assert-reply.js` | `notAnAPIReply`：2xx 却不是 API 回复的判定顺序（Content-Type 是 HTML 直接拒；body 首字节即 EOF 拒；`Content-Encoding` 非 `identity` 时跳过全部嗅探；HTML 特征命中且 CT 不含 `xml` 才拒；CT 含 `json` 但首字节不是 `{`/`[` 才拒）、`htmlStart` 正则、以及「只 `Peek` 一次、绝不为了嗅探把缓冲攒满」 | Go → JS 重写。**改了两处**：① magpie 只处理 2xx（非 2xx 归它自己的分类器），我们对**非 2xx** 也加了一条最窄的检查（CT 是 `text/html` **且** body 真的是 HTML 文档开头）——因为我们的 `httpError` 会把 403 判成 AUTH 并把账号冷却 24 小时，于是「Cloudflare 拦了一下」会变成「这个账号令牌废了」；② magpie 把响应改写成 502 JSON，我们抛带 `code='NOT_AN_API_REPLY'` 的 Error，因为我们的分类器吃 `error.code`（归类为瞬时故障，换号但不罚账号）。 |
| `internal/gateway/fallback.go` | `src/pool.js` | 换号窗口的三个上限（`holdLongest` / `holdThinking` / `holdMost`）与「哪个厂商会在只思考之后用安全策略拒绝」的判据（`refusesAfterThinking`）：Claude 系与 GPT 系 true，模型名去掉最后一段 `/` 之后以 `gemini` 开头 true，**其余 false** | Go → JS 重写；常量语义照搬（15s / 4min / 1 MiB），注释改写为中文并保留 issue 编号「#248」。**改了一处**：magpie 在憋住期间会往流里写保活注释，我们**不做**——它是自己写 HTTP 响应头的外层网关，`Codex` 会等流的下一帧等 300 秒；我们是进程内 adapter，没有能写 SSE 注释的那一层，宿主也没有流空闲超时（`dsh-llm` 全文无 `idle`/`stall`/`keepalive`），所以保活在这里无处可写也无必要。 |
| `internal/gateway/routing.go` | `src/wire/failure-words.js`、`src/health.js` | 退避常量表（`longestWait` 1h / `longestQuota` 8d / `longestRetry` 10min / `longestRateRest` 30min / `rateForget` 30min / `creditRest` 30min / `quotaRest` 15min，以及 `fallback.go:35` 的 `fallbackCooldown` 1min）、`failure()` 的 429 / 402 文本判定顺序与六个正则（`creditWords` / `brokeWords` / `usedUpWords` / `rateWords` / `plannedWords` / `resetsWords`）、`rateRest()` 的退避算法（还在冷却里就不再拉长、冷却结束后 `rateForget` 内 +1、上游说的时长**不短于**退避值才生效）、`retryAfter()` 把 `Retry-After` 与「同时含 `reset` 与 `ratelimit` 的头」裁到 `longestWait` | Go → JS 重写；常量名与 issue 编号（#147 / #153）留中文注释。**改了四处**：① `rateForget` 对两种退避（限流与普通故障）都生效，magpie 只给限流设遗忘期、`failOther` 一路累加；② `THROTTLED_STATUS` 含 503/529，magpie 只认 429，于是「503 + Rate limit exceeded」在这里会被认成限流而不是「服务器炸了」；③ `BROKE_WORDS` 多两条（`out of (credits?|funds?|balance)` / `no (credits?|funds?|balance)`），magpie 只认 `insufficient.?(balance\|credit\|fund)`；④ `quotaRest` 由 5 分钟改为 15 分钟，并把 402 / `ACCOUNT_QUOTA` 从额度里拆成 `CREDIT`（罚整个账号）。**未借用**：`Limit.For()` 的窗口级 `resetAt` 规则（它服务额度读数驱动的路由，属 W6/W7）。 |
| `internal/gateway/sink.go` | `src/select.js` | Sink：**还有额度却吃了限流**（`failRate`，不是额度用尽也不是欠费）的账号沉到路由末尾——沉过的排在没沉过的后面，沉得早的排在沉得晚的前面；沉表只在内存里、重启即忘。其文件头的设计理由照抄进中文注释（一个账号被打到限流、冷却一结束又被灌满请求，正是风控最容易注意到的形状）。 | Go → JS 重写。`sinkOrder(n, at)` 返回下标数组、由调用方在外层重排，这里写成一个纯函数 `sinkOrder(order)` 返回新数组；稳定性语义相同（`Array.prototype.sort` 是稳定的，序号相同时保持路由给出的相对顺序）。沉表的键与「什么时候沉」都由 `src/pool.js` 提供。 |
| `internal/gateway/routing.go` | `src/select.js` | 账号排序的七条判据：`learns`（额度未知、而这一族读得出额度的，先让它答一次）→ 三档（`lowShare` 90 / `usedShare` 98）→ 同档按使用比例 → `band`（pace 相差不到 1/10 算同档）→ 逐窗口比重置时间（**`Truncate(time.Hour)`，只比到小时**）→ 近期用量（`usageHalfLife` 1h 的 `2^(-Δt/1h)` 衰减）→ id；以及 `pace` 的算法「`(100 - used) / max(距离重置, 1 小时)` 取最小」与未知账号的 `FreshPace = 100/(7*24)` | Go → JS 重写；常量与源码注释里的理由（「三个 pace 各差十二分之一会绕圈，所以必须先离散成 band」）留中文注释。**改了四处**：① 我们拿不到窗口跨度，`soon` 用「重置时刻最远的先比」来近似「窗口最大的先比」；② magpie 的 Smart 与 Pace 是两个 `routing` 模式（前者桶内比重置时间、后者比 pace 分带），我们合成**一条**顺序——桶内先比 pace 分带、再比重置时间；③ 近期用量数的是**请求数**不是 token 数（`usage` 不是每条路径都给，而请求数是所有路径都拿得到的；它排在最后一条判据，作用只是把并列的账号摊开）；④ `learns` 的判据从 magpie 的 `agent == "claude"` 换成「这一族实现了 `quota()`」——我们没有 Claude Code 的 `rate_limit_event`，额度是从族自己的 `quota()` 读来的。 |
| `internal/gateway/affinity.go` | `src/affinity.js` | 会话粘性的四态（`auto`/`session`/`turn`/`off`）、`affine()` 那个「顺序即优先级」的判定 switch（`off` → `first` → `gone` → `resting` → `spent` → `session` → `turn` → `new-turn` → `no-cache` → `cold` → `cache`）、常量 `cacheWorth` 1024 / `cacheCold` 5min / `stickKeep` 24h / `sticksKept` 512、`answered()` 记「谁答的 + 那次读到多少缓存」、`turnIn()` 的「轮内」判据（最后一条 user 消息说了算）、`saveSticks()` 的原子写与「只留最近 512 条」、以及 `spent` 那一条的 `at > 0`（**「几乎用满」本身不换号**，只有它已经不在第一位了才不拉回来） | Go → JS 重写；文件头原文（翻译）与 issue 编号保留在中文注释里。**改了三处**：① 记录键从 magpie 的 `scope\|conversation` 改成 `${familyId}-${sha256(model+conversation)}`（**带模型**）——我们的候选集本来就按模型过滤过，magpie 那三级谓词（账号+模型+档位 → 账号+模型 → 账号）在我们这里退化成「账号相同」，带模型只影响查的是哪一条记录，不带的话一段会话里换个模型问一句就会把上一条覆盖掉、两个模型轮流把对方挤走；② `role: 'tool'` 也算轮内——magpie 的消息是 Anthropic 形状（工具结果是 user 消息里的 part），DSH 的工具结果是**独立的一条 `role: 'tool'` 消息**，只认 user 的话 `within` 永远不为真；③ 落盘走 `ctx.storageDomain`（`~/.dsh/storages/account_bridge.json`），不是 magpie 那样在 providers 旁边自己写 `affinity.json`——宿主已经把 `dsh-storage` + `storage-json` + `storage-domain` 挂在每个 profile 的 `dsh-base` 里了，而**我们不能 import `@deepseek-ai/dsh-storage-domain`**（裸模块名 import 核心包会 `ERR_MODULE_NOT_FOUND`，见 `test/contract.test.js`），所以 spec 是手工拼的、`valueSchema.parse` 在校验失败时**故意抛**（读不懂就是读不懂，当成「没有」会在下一次落盘时把那条永久抹掉，正是 `LESSONS.md` 第 9 条）。**未借用**：`heldFor` 的「持有会话数」计数与 `leastHeld()` 的负载摊开（我们只有 `select.js` 那一套顺序）。 |
| `internal/gateway/rpm.go`、`internal/gateway/concurrency.go` | `src/gate.js`、`src/pool.js` | 两个每账号闸门的语义：**每分钟请求数**（`rpmWindow` 一分钟、`rpmLongest` 两分钟、`MaxRPM` 的「凡是真发出去的就计数」口径——每一次重试、每一个下一个账号、每一次 fallback、一次尝试途中补的第二次请求、以及网关自己向 provider 发的那些；`reserve`/`giveBack`/`wait`/`free`/`used` 的形状：时刻表只增不减所以天然有序、窗口里满了就等「倒数第 limit 个」满一分钟、`<= now-window` 的丢掉）与**并发数**（`lane{limit,busy,queue}`、先来后到、有人还槽就直接交给队首而不是减 `busy`、「等待不是失败——排队中的请求绝不因为没槽就让给 fallback，它等的那个账号也不休息」、`errQueueFull`/`errQueueWait`、以及 `laneMate`：没余量的账号让位给同族里此刻有余量的） | Go → JS 重写；`who()` → `whoOf(family, accountId)`（建在 `src/pool.js`，形如 `generic/generic-3`）、常量与源码注释里的理由（Discord 上 coeo91 的原话「OpenRouter 免费模型一分钟 20 个，限并发 1 挡不住」、Lemon 的「Codex 账号并发五六个以上会被风控」）留中文注释。**改了六处**：① 键从 magpie 的 `who()`（provider 内的一把 key 或一个账号）改成 `族/账号 id`——我们的账号就是我们的账号，没有 key 这一层；② magpie 转开时回的是 HTTP 429 + `Retry-After`（它是外层网关，有自己的响应可写），我们抛 `code='LOCAL_RATE_LIMIT'` 的错误，带 `retryAfterSeconds` 与 `error.failure.providerRetryAfterMs`——**不叫 `RATE_LIMIT`**，因为后者在这仓的冷却表里意味着「上游限流了这个账号」，而这个错误恰恰说明包根本没出去；`classifyFailure` 把它归为 `action:'throw'`（**谁也不罚**），对应 magpie 的「a failure that rests nobody」；③ `rpmWindow`/`rpmLongest` 是 magpie 的包级变量（注释写明「tests shorten them」），我们是构造函数选项；④ 时间与睡眠可注入（`now`/`sleep`），magpie 用自己的时钟；⑤ **并发队列的上限与等待上限是我们定的数**（`LANE_QUEUE_LIMIT` 64、`LANE_WAIT_MS` 2 分钟）——magpie 的 `acquire` 是无界排队（`take(ctx, who, limit, 0, 0)`），有界的那个 `QueueLimit`/`QueueWait` 来自 provider 配置，而我们没有那一层；因此「等超时就换下一个账号」也是我们的选择，magpie 只在配置的界超了之后才换；⑥ 面板可见的快照（`snapshot()`/`laneState()`）是我们加的，magpie 只在路由的 try 里告诉调用方「排队中」（`Try.Queued`）。 |

### RelayKit / new-api（AGPL-3.0，Copyright QuantumNous）

见文末「只学规格、未借用代码」——AGPL 的来源不进「借用的代码」这一节。

## 计划借用（尚未落地，落地时连同头部注释一起移入上一节）

> 这些行**不受** `test/notices.test.js` 强制，因为文件还不存在。它们记录的是意图，
> 实现时若改了主意，改这里而不是硬凑。

### magpie（MIT，Copyright (c) 2026 yetone）

来源：<https://github.com/yetone/magpie>，基线提交 `d7a1b02`。

| 上游文件 | 计划用在本仓 | 内容 | 计划怎么改 |
|---|---|---|---|
| `LESSONS.md` | 全仓 | 第 9 条：读／解析／哈希失败等于「未知」，永不等于「空」 | 规则，非代码 |
| `internal/agent/dsh.go` | 文档 | DSH 的补丁层语义、自定义提供方的字段形状与宿主默认值 | 规则与字段名，非代码 |

### AstrLink（Apache-2.0，Copyright Calcium-Ion）

来源：<https://github.com/Calcium-Ion/AstrLink>，基线提交 `5ceced5`。

> `claude_identity.go` 一行已于 W5 落地，见上面「借用的代码」。

## 只学规格、未借用代码

以下来源我们**只借鉴了设计与规则**（事实性的字段名、常量、判定顺序），没有复制任何可执行表达。
本节的表格**不受**「头部必须指向本文件」那条约束——恰恰相反，这一节的落地点里有些
（比如 `src/wire/usage.js`）**故意不写上游的名字**，而另一些写了；两种都可以。
本节只受一条约束：**写了名字的文件必须在这里登记**（`test/notices.test.js` 的反向守卫会查）。

| 上游 | 落地点 | 学的是什么 |
|---|---|---|
| **RelayKit**（`QuantumNous/new-api/relaykit`，**AGPL-3.0**） | `src/wire/usage.js`、`src/wire/diagnostics.js` | ① usage 合并的「非零才覆盖」；② 结构化诊断的形状（`code` / `severity` / `path` / `from` / `to`）与两档严重性；③ 未知停止原因原样透传不伪造；④ golden 快照的组织方式；⑤ `continuation_state_lost` 这条诊断（W4 的立项理由） |
| **AstrLink `docs/`**（Apache-2.0） | 文档与规则 | 粘性可审计、上游身份铁律、未计价不猜 |
| **V1ki/dsh-plugin-subscriptions**（MIT） | `src/wire/replay.js` | 回放信封的**必要性判断**（「签名不能像我们原来那样直接扔掉」）与「按 `kind` 分开命名空间」 |

- **为什么 RelayKit 只算「只学规格」**：规则本身大多是协议事实（「分片上报的计数要合并」不是任何人的表达），
  换个语言、换个数据结构重写不构成衍生；本仓没有引入它的任何源码、常量表、诊断码清单或数据结构
  （`relaykit/` 是 Go 模块，与本仓技术栈也不同），也没有采用它最重的那部分（`toolconv` 的 hosted-tool
  全矩阵、`relayconvert` 的协议 IR）——那是聚合网关的业务面，不是账号级反代需要的。
  本仓的 `src/wire/diagnostics.js` 里**没有 RelayKit 的诊断码清单**：我们用自己起的八个码，
  一条一条对应自己真的会丢东西的地方。
- **若将来要真正复制它的代码**，就得改成与 magpie 同样的「借用的代码」台账行，并且**整仓都受
  AGPL-3.0 传染**；本仓的选择是不复制。
- **V1ki 那一份是 TypeScript 的 Antigravity 线，没有一行进入本仓**——本仓不知道 Antigravity 的
  思考签名长什么样，也还没验过它。信封的形状（`{response:{kind,version,model},blocks}`）与校验项
  （种类、版本、模型、块数、逐块类型、签名只许出现在 `reasoning` 块上）**全部是宿主自己的约定**，
  我们是从 `@deepseek-ai/dsh-llm-deepseek` 与 `@deepseek-ai/dsh-llm-pi-ai` 这两个随宿主发布的
  适配器里读出来的（`pi-ai` 用 `kind:"pi-ai"`、`version:2`，我们照这个先例取了自己的 `kind`）。
- **`continuation_state_lost` 的处置我们改了**：RelayKit 把它记成 error 级且用中央码表；本仓不设中央
  码表，`replayState` 是宿主已有的通道——能带就带，带不了报一条自己的 `CONTINUATION_STATE_LOST`
  （见 `src/wire/responses.js` 的收尾）。
