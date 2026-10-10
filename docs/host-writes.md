# 写宿主的配置文件：四条红线

**这份文档现在不是「我们在做的事」，是「我们将来要做这件事时必须遵守的规矩」。**
本插件今天**一个字节都不往宿主的配置文件里写**：账号凭据走 `ctx.credentials`（宿主自己的
凭据服务），模式与粘性走 `ctx.storageDomain`（`~/.dsh/storages/account_bridge.json`），
装插件/卸插件交给 `dsh plugin add|remove`。唯二会写盘的地方是 `src/families/grok.js` 与
`src/families/minimax.js`，写的是**厂商客户端自己的** `auth.json`（刷新令牌轮换后回写，
带 generation CAS，见 README「MiniMax Code」一节）。

那为什么还要写下来？因为**一旦**我们做「帮你把默认模型指到这个池子」或「把网关 key 装进
宿主」这类功能，就会去动 `~/.dsh/profiles/*/cordis.patch.yml`——而那份文件**不止我们在写**。

## 为什么这件事危险：magpie 也在写，而且它只防自己

magpie（MIT，用户可能同时装着）是原生支持 DSH 的，它写的就是 profile 的 `cordis.patch.yml`。
它有一把自己的锁，`internal/agent/dsh.go:783-787` 的注释原文：

> dshWrites serializes magpie's own writers of dsh's patch lists: the sync a catalog change asks
> for, a model picked here, and the round magpie does while it serves the gateway. Two of them
> reading one file and then writing it would leave whichever read first as its content.

**它防的是「自己进程里的两个 goroutine 抢」，防不了另一个进程。** 两个程序之间没有任何互斥：
我们「读→改→写」的那一小段时间里它也可能读→改→写，谁先读谁的内容就被整份覆盖。
社区里改 `cordis.patch.yml` 的插件不止一家，这个风险不是 magpie 独有的。

## 四条红线

| 红线 | 具体怎么做 | 为什么 |
|---|---|---|
| **① 绝不整份重写 `cordis.patch.yml`** | 只能 read-modify-write：先按原文**逐行**读进来，只替换/插入属于我们自己的那一条，其它行按字节保留；写失败就放弃，不留半个文件 | 整份重写 = 把 magpie 的 `# magpie` 行、用户手改的行、别家插件插的行全部盖掉。这份文件是**多主**的 |
| **② 避开这 6 个 row id** | `agent-default-model` / `llm-pi-ai` / `web-search-deepseek` / `llm-deepseek` / `agent-loop` / `api-gateway` | 这 6 条是 magpie 明确要改的。尤其 `agent-default-model`：**DSH 0.2 起把「当前模型选择」写在最后一条该条目的 `config` 里**，magpie 会把它 `stash` 走再换掉（`internal/agent/dsh.go:295-302`）。我们去固定默认模型就是和它争同一行 |
| **③ 凭据要写两处** | `$DSH_HOME/.env` 里一行 `NAME=value`，**并且**在 `$DSH_HOME/.credentials.yaml` 的 `refs:` 下写 `NAME: value` | 桌面版**只读 store** 那一份（magpie 的 `dshKeyRef = "MAGPIE_GATEWAY_KEY"`，`internal/agent/dsh.go:56`、`:741`、`:896` 就是这两处）。只写 `.env` 会得到 `no credential for provider route …` |
| **④ 只删自己写的值** | 删之前先比对「这个值是不是我们写的那一个」；不是就留着并报告 | 同一个键可能是用户自己写的、或别家插件写的 |

## 真要写的话，动作清单

1. **写前重读**：不要凭内存里的旧内容重建（`cordis.patch.yml` 有 37KB，用户随时在手改）。
2. **只碰自己那一条**：按 `id` / `name` 定位；找不到就插在自己的区块里，别插进别人的。
3. **原子写**：同目录 `*.tmp-<时间>-<随机>` → `chmod 0600`（凭据文件）→ `rename`。
4. **写后重读校验**：我们的条目在、**别人的条目也还在**；不一致就报告，不要二次修改。
5. **两次读之间文件变了 ⇒ 放弃**（比对 mtime + 内容哈希）。猜一次的代价是用户整份配置。
6. **只写 `$DSH_HOME` 下这些文本文件**，不碰 `node_modules/`、不手改 profile 的 `package.json`
   （装包一律交给 `dsh plugin add`，它自己会还原失败的安装）。
7. **先备份**：`cordis.patch.yml.bak-<时分>`，并且**不删别人的备份**（现在 profile 目录里就有
   用户自己留的若干 `.bak-*`）。

## 这条纪律怎么被钉住的

- `test/host-writes.test.js`：静态扫描 `src/**/*.js`，**会写盘的文件必须正好是那两个厂商客户端
  文件**；它们以及其余源码里都不许出现 `cordis.patch.yml` / `cordis.yml` / `.credentials.yaml`
  的写操作；这份文档必须还在，且**那 6 个 row id 与四条红线的标题必须逐字还在**（防止文档被
  慢慢改空，而代码那边以为规矩还有效）。
- 引用来源与许可：magpie 是 MIT，署名在 `THIRD_PARTY_NOTICES.md` 的「借用的代码 → magpie」一节
  （`internal/agent/dsh.go` 那一行）。
