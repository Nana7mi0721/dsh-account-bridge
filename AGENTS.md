# dsh-account-bridge

把**已经登录的订阅账号**池化成 DSH 里的一组 provider。不是「再填一个 API Key」的插件：
它复用本机客户端的登录态（ChatGPT 订阅、Claude Pro/Max、Antigravity、MiniMax Code、Qoder、
CodeBuddy、CommandCode、Grok、GitHub Copilot、Trae），加上一个通用兜底族收任意
OpenAI / Anthropic 兼容端点，一共十一条 `acct-*` route。多个账号同一个账号池，谁坏了换谁。

这一份是给在这里写代码的 agent（人和模型都算）看的规矩。读完就能开工；更细的东西在 `docs/`。

## 硬规矩

| 规矩 | 为什么 | 怎么自查 |
| --- | --- | --- |
| **测试只有端到端** | 见下一节。这个插件的全部价值在「接上去是对的」，假对象只能证明「函数按我写的假想工作」 | `ls test/` 里只应有 `e2e/`；`grep -rln "node:test" test/` 只应命中 `test/e2e/e2e.test.js` |
| **不许 import `@deepseek-ai/*`** | 核心包住在 `app.asar` 里，插件目录解析不到；按裸模块名 import 会 `ERR_MODULE_NOT_FOUND`（真机复现过） | 只能经 `ctx` 服务取能力；harness 的前置检查会扫源码 |
| **凭据不出站** | 这个仓库的主题就是凭据 | 不写日志、不进回环响应、不进错误消息。`publicAccount()` 是白名单重建：`auth` 加新字段默认不外传 |
| **只动自己写的值** | 用户的 `cordis.patch.yml` 里躺着别人的东西（magpie 就把自己的行放在同一个文件里） | 四条红线与六个必须避开的 row id 见 `docs/host-writes.md` |
| **加一个族之前先读 `docs/family-contract.md`** | 族的形状、`refresh` 返回什么、`stream` 的 chunk 契约、失败怎么归类，都在那里 | 抄一个最近的族，不要从零发明 |
| **「读不出来」不等于「没有」** | magpie 的三次真实事故：解析失败返回空表 ⇒ 下一次写盘把真数据抹掉；两个读不出的文件夹被当成相等 ⇒ 删掉副本 | 读失败就不会有「空」这个结论：要么报未知，要么不写盘 |
| **借来的代码必须登记** | 四家参考实现的许可不同（MIT / Apache-2.0 / AGPL-3.0） | 写进 `THIRD_PARTY_NOTICES.md`，并在那个文件里出现它的路径；AGPL 的部分一个字节都不抄 |
| **不许把失败说成跳过** | 跳过的端到端测试等于没有测试 | 报告缺一条都算失败 |

## 测试：只有端到端

`npm test` 干的事：

```
假上游（test/e2e/mock-upstream.mjs，端口由系统分配）
   ↓
真宿主（桌面版那个可执行文件，ELECTRON_RUN_AS_NODE=1，专用 profile）
   ↓  插件以 link: 装进去 ⇒ 改源码即时生效
探针（test/e2e/probe/index.js）在宿主里跑完全部检查，写一份 JSON 报告
   ↓
test/e2e/e2e.test.js 逐条把它变成测试结果
```

**不写单元测试、不写回归测试、不写假宿主替身。** 要加检查就改探针（`test/e2e/probe/index.js`），
不要新建测试文件——`test/` 下除了 `e2e/` 不该有别的东西。

```bash
npm test                          # 全部
node test/e2e/harness.mjs         # 手工跑一轮，打印每条检查
node test/e2e/harness.mjs --quiet # 同上，不转发宿主输出
```

- 第一次在某台机器上跑会**装机**（几十秒，要走网络：空白 home 上要拉 `dsh-base` 与 `dsh-web-app`）；
  之后每次约一分钟。装在 `test/e2e/.home`（已 gitignore），**不动你自己的 `~/.dsh`**。
- 宿主不在默认位置时：`DSH_DESKTOP`（安装目录）或 `DSH_HOST_EXE` / `DSH_HOST_CLI`；
  换装目录：`BRIDGE_E2E_HOME`；宿主里没有 web-app 时可 `BRIDGE_E2E_WEBAPP_VERSION` 指定版本。
- 探针在宿主里做事，有四条宿主契约必须遵守，见下。
- 假上游是**刻意难伺候**的：Anthropic 那条路只发 `data:` 不发 `event:`；不认 `stream_options`；
  不认 `cache_control`；不认 Claude Code 的身份块；还专门有几个「坏模型」
  （先吐思考再报错、返回一个 HTML 页面、403 的 Cloudflare 页、429 说「一周后再来」、429 说「余额不足」）。
  它是验收台，不是便利设施——**不要为了让自己那关过而把它改宽容**。

## 四条宿主契约（都是踩出来的）

1. `ctx.inject([...], cb)` 的回调里**抛出去是静默的**：探针会一声不响地停在半路。
   整段必须包 try/catch，并且无论如何都要把报告落盘。
2. 适配器抛的错，宿主**不会**转给调用方，而是变成一个
   `{ type: 'finish', reason: { kind: 'error', failure: { message, code } } }` 块。
   判断一次推理成没成，要看这个块，不是看有没有 throw。
3. `llm.listProviders()` 之类的返回值**不一定是 promise**（可能同步返回数组），
   对返回值直接 `.catch()` 会抛 TypeError。
4. 适配器收到的消息里，图片块是 `{ type: 'image', attachment: { attachmentId, mediaType, … } }`,
   **不是** base64。要自己经 `ctx.get('attachments')` 的 `readImage(ref)` 解引用
   （池子在 `#withImageData` 里替所有族做了一次，读不到就照实报诊断、不吞）。
   助手轮还带 `source: { kind: 'model', provider, model }`，缺了宿主会在 `source.replayState` 上抛。
   ——`ctx` 是 `src/index.js` 那个 `familyContext`，**它的 `get` 是通往宿主服务的唯一门**；
   曾经它连 `get` 都没有，于是图片与 CommandCode 的凭据源被静默废掉了一整轮。

## 目录

| 位置 | 是什么 |
| --- | --- |
| `src/index.js` | 装配：把族、池子、工具、命令、面板、回环面接到 `ctx` 上 |
| `src/pool.js` | 账号池与适配器：选号、换号、失败归类、额度、冷却、诊断账本 |
| `src/select.js` / `src/affinity.js` / `src/gate.js` | 按额度排序 / 会话粘性 / 每分钟与并发闸门 |
| `src/health.js` / `src/wire/failure-words.js` | 失败分类与「两套通道共用一份词表」 |
| `src/families/*.js` | 十一个族，一族一个文件；`registry.js` 里的顺序就是界面顺序 |
| `src/wire/*.js` | 协议翻译层（Anthropic / Responses / Chat Completions / SSE / 各家的私有信封） |
| `src/api.js` / `src/tools.js` / `src/commands.js` / `src/client.js` | 回环数据面 / 工具面 / `/pool` 命令 / 设置面板 |
| `src/login/` | 登录中介与回环回调 |
| `docs/family-contract.md` | 写一个族的完整规格 |
| `docs/host-writes.md` | 写宿主配置的四条红线 |
| `test/e2e/` | 唯一的测试：假上游 + 真宿主 + 探针 |

## 改完要做的三件事

1. `npm test` 绿。
2. 用户看得见的东西同步：`README.md` 的能力状态表、`docs/` 里对应的那一节。
3. 提交信息说**为什么**，不只是「改了什么」。测试计数、真机结论这类事实写进 README 或
   计划书里对应的小节，别只留在提交信息里。

## 风格

照现有源码：ESM、无分号、两空格缩进、命名导出（族一律 `export const xxxFamily`，没有 default）。
注释写「为什么」——写清楚这个判断是踩了什么坑才加上的，下一次的人才不敢删。中文注释。
