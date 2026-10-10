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
> 本节目前为空——P7 深度改进（W0–W11）尚未开始落地。

## 计划借用（尚未落地，落地时连同头部注释一起移入上一节）

> 这些行**不受** `test/notices.test.js` 强制，因为文件还不存在。它们记录的是意图，
> 实现时若改了主意，改这里而不是硬凑。

### magpie（MIT，Copyright (c) 2026 yetone）

来源：<https://github.com/yetone/magpie>，基线提交 `d7a1b02`。

| 上游文件 | 计划用在本仓 | 内容 | 计划怎么改 |
|---|---|---|---|
| `internal/gateway/fallback.go` | `src/pool.js` | 保流窗口的三个上限（等首段内容 / 只有思考时），以及「哪个厂商会在只思考之后用安全策略拒绝」的判据 | Go → JS 重写；常量语义照搬，注释改写为中文并保留 issue 编号 |
| `internal/gateway/notapi.go` | `src/wire/assert-reply.js` | `notAnAPIReply`：2xx 但不是 API 回复的判定顺序（含压缩流跳过嗅探、XML 放过两条例外） | Go → JS 重写 |
| `internal/gateway/routing.go` | `src/health.js`、`src/select.js` | 退避常量表、429 文本分流、额度分档与「重置最快优先」、「相差 1/10 视为同档」的离散分带 | Go → JS 重写 |
| `internal/gateway/sink.go` | `src/select.js` | 被限流（而非额度用尽）的账号沉到路由末尾，以及「沉得早的排在沉得晚的前面」 | Go → JS 重写 |
| `internal/gateway/affinity.go` | `src/affinity.js` | 会话粘性的跨轮保持判据（按上游实际回报的缓存读取量，而不是固定 TTL） | Go → JS 重写 |
| `internal/gateway/rpm.go`、`busy.go` | `src/gate.js` | 每分钟请求数闸门与并发闸门；「每一次真正发出的请求都计数」；等待超限改为明确拒绝 | Go → JS 重写 |
| `LESSONS.md` | 全仓 | 第 9 条：读／解析／哈希失败等于「未知」，永不等于「空」 | 规则，非代码 |
| `internal/agent/dsh.go` | 文档 | DSH 的补丁层语义、自定义提供方的字段形状与宿主默认值 | 规则与字段名，非代码 |

### AstrLink（Apache-2.0，Copyright Calcium-Ion）

来源：<https://github.com/Calcium-Ion/AstrLink>，基线提交 `5ceced5`。

| 上游文件 | 计划用在本仓 | 内容 | 计划怎么改 |
|---|---|---|---|
| `core/internal/accountauth/claude_identity.go` | `src/util.js`、`src/families/claude.js` | 会话标识按账号分命名空间（并置成 UUID 形状）、每个账号一个稳定设备标识、`metadata.user_id` 的两种形态 | Go → JS 重写；**该文件不链接 RelayKit**，已核对 |

### V1ki/dsh-plugin-subscriptions（MIT，Copyright (c) 2026 V1ki）

来源：<https://github.com/V1ki/dsh-plugin-subscriptions>。

| 上游文件 | 计划用在本仓 | 内容 | 计划怎么改 |
|---|---|---|---|
| `src/translate/antigravity.ts` | `src/wire/replay.js` | 思考签名的累加与回放信封的形状与校验项 | TypeScript → JS 重写 |

## 只学规格、未借用代码

以下来源我们**只借鉴了设计与规则**（事实性的字段名、常量、判定顺序），没有复制任何可执行表达：

- **RelayKit**（`QuantumNous/new-api/relaykit`，**AGPL-3.0**）：结构化诊断的形状与两个严重级别、未知停止原因原样透传、usage 合并的「非零才覆盖」规则、golden 快照的组织方式。
- **AstrLink `docs/`**（Apache-2.0）：粘性可审计、上游身份铁律、未计价不猜。
