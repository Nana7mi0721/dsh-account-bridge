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

### RelayKit / new-api（AGPL-3.0，Copyright QuantumNous）

见文末「只学规格、未借用代码」——AGPL 的来源不进「借用的代码」这一节。

## 计划借用（尚未落地，落地时连同头部注释一起移入上一节）

> 这些行**不受** `test/notices.test.js` 强制，因为文件还不存在。它们记录的是意图，
> 实现时若改了主意，改这里而不是硬凑。

### magpie（MIT，Copyright (c) 2026 yetone）

来源：<https://github.com/yetone/magpie>，基线提交 `d7a1b02`。

| 上游文件 | 计划用在本仓 | 内容 | 计划怎么改 |
|---|---|---|---|
| `internal/gateway/affinity.go` | `src/affinity.js` | 会话粘性的跨轮保持判据（按上游实际回报的缓存读取量，而不是固定 TTL） | Go → JS 重写 |
| `internal/gateway/rpm.go`、`busy.go` | `src/gate.js` | 每分钟请求数闸门与并发闸门；「每一次真正发出的请求都计数」；等待超限改为明确拒绝 | Go → JS 重写 |
| `LESSONS.md` | 全仓 | 第 9 条：读／解析／哈希失败等于「未知」，永不等于「空」 | 规则，非代码 |
| `internal/agent/dsh.go` | 文档 | DSH 的补丁层语义、自定义提供方的字段形状与宿主默认值 | 规则与字段名，非代码 |

### AstrLink（Apache-2.0，Copyright Calcium-Ion）

来源：<https://github.com/Calcium-Ion/AstrLink>，基线提交 `5ceced5`。

> `claude_identity.go` 一行已于 W5 落地，见上面「借用的代码」。

### V1ki/dsh-plugin-subscriptions（MIT，Copyright (c) 2026 V1ki）

来源：<https://github.com/V1ki/dsh-plugin-subscriptions>。

| 上游文件 | 计划用在本仓 | 内容 | 计划怎么改 |
|---|---|---|---|
| `src/translate/antigravity.ts` | `src/wire/replay.js` | 思考签名的累加与回放信封的形状与校验项 | TypeScript → JS 重写 |

## 只学规格、未借用代码

以下来源我们**只借鉴了设计与规则**（事实性的字段名、常量、判定顺序），没有复制任何可执行表达：

- **RelayKit**（`QuantumNous/new-api/relaykit`，**AGPL-3.0**）：结构化诊断的形状与两个严重级别、未知停止原因原样透传、usage 合并的「非零才覆盖」规则、golden 快照的组织方式。
  - 落地处：usage 合并规则在 `src/wire/usage.js`（含上游没有的惰性拷贝与 `mergeUsageFrames`）。
  - **为什么这是「只学规格」而不是「借用」**：规则本身是协议事实（「分片上报的计数要合并」不是任何人的表达），换个语言、换个数据结构重写不构成衍生；本仓没有引入它的任何源码、常量表、诊断码清单或数据结构（`relaykit/` 是 Go 模块，与本仓技术栈也不同），也没有采用它最重的那部分（`toolconv` 的 hosted-tool 全矩阵、`relayconvert` 的协议 IR）——那是聚合网关的业务面，不是账号级反代需要的。
  - `src/wire/usage.js` 的头部注释里**故意不提**它的名字：`test/notices.test.js` 有一条反向守卫，任何登记在「借用的代码」里的文件都不许出现 `relaykit`，而这个文件不属于那一节。
  - 若将来要真正复制它的代码，就得改成与 magpie 同样的台账行，并且**整仓都受 AGPL-3.0 传染**；本仓的选择是不复制。
- **AstrLink `docs/`**（Apache-2.0）：粘性可审计、上游身份铁律、未计价不猜。
