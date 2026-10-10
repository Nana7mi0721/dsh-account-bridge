/**
 * 账号仓库：把每个账号存成一条 DSH 凭据记录。
 *
 * 为什么不用插件私有文件（V1ki / dockyard / dsh-router 的三种做法都不取）：
 * - 机密只走 `ctx.credentials`，DSH 自己的凭据 UI 就能看到「已配置」；
 * - `modifyRecord` 的读-改-写带跨进程文件锁，天然解决「两个进程同时轮换 refresh token」；
 * - 卸载后记录还在，`listRecords()` 能把孤儿账号列出来。
 *
 * 记录寻址：`dsh-account-bridge/<family>-<n>`（如 `dsh-account-bridge/codex-1`）。
 * 段名必须匹配 `/^[a-z][a-z0-9-]*$/`。
 * @module dsh-account-bridge/store
 */

/** 本插件所有凭据记录的 scope 段。 */
export const SCOPE = 'dsh-account-bridge'

const SEGMENT = /^[a-z][a-z0-9-]*$/
const ACCOUNT_ID = /^([a-z][a-z0-9]*)-(\d+)$/

/** 校验一个 id 能不能直接当凭据键的 id 段。 */
export function assertSegment(value, what) {
  if (typeof value !== 'string' || !SEGMENT.test(value)) {
    throw new Error(`${what} "${value}" must match ${SEGMENT}`)
  }
  return value
}

/** `<family>-<n>` → `{family, index}`；不匹配返回 undefined。 */
export function parseAccountId(id) {
  const match = ACCOUNT_ID.exec(String(id ?? ''))
  if (!match) return undefined
  return { family: match[1], index: Number(match[2]) }
}

/** 账号仓库。 */
export class AccountStore {
  #resolve
  #log
  #cached

  /**
   * @param {object|(() => object|undefined)} credentials `credentials` 服务，或一个取它的函数。
   *   传函数是为了让插件能在服务还没就绪时就构造好 store（惰性注入下很常见）。
   * @param {any} [log]
   */
  constructor(credentials, log) {
    this.#resolve = typeof credentials === 'function' ? credentials : () => credentials
    this.#log = log
  }

  /** 取 `credentials` 服务；没就绪时给一个可读的错误而不是 TypeError。 */
  get #credentials() {
    this.#cached ??= this.#resolve()
    const service = this.#cached
    if (!service) {
      const error = new Error('account-bridge: the credentials service is not available in this profile')
      error.code = 'MISSING_CREDENTIAL'
      throw error
    }
    return service
  }

  /** 服务实例变了（热重载）时清掉缓存。 */
  reset() {
    this.#cached = undefined
  }

  /** 记录键。 */
  keyOf(id) {
    return `${SCOPE}/${assertSegment(id, 'account id')}`
  }

  /** 读一条账号记录，返回 payload（不存在返回 undefined）。 */
  async read(id) {
    const record = await this.#credentials.readRecord(this.keyOf(id))
    return record?.payload
  }

  /** 写一条账号记录（整条替换）。 */
  async write(id, payload) {
    const key = this.keyOf(id)
    await this.#credentials.modifyRecord(key, () => ({
      kind: 'grant',
      payload: { ...payload, id, updatedAt: new Date().toISOString() },
    }))
    return this.read(id)
  }

  /** 读-改-写：`mutate(current)` 返回新 payload，或 undefined 表示不改。 */
  async update(id, mutate) {
    const key = this.keyOf(id)
    let next
    await this.#credentials.modifyRecord(key, (current) => {
      next = mutate(current?.payload)
      if (next === undefined) return undefined
      return { kind: 'grant', payload: { ...next, id, updatedAt: new Date().toISOString() } }
    })
    return next
  }

  /** 删除一条账号记录。 */
  async remove(id) {
    await this.#credentials.deleteRecord(this.keyOf(id))
  }

  /** 列出全部账号（可选按族过滤），按 id 排序。 */
  async list(family) {
    return (await this.#scan(family)).accounts
  }

  /**
   * 扫描本插件的记录，分出「能用的账号」与「占了号但读不出内容的」。
   *
   * 为什么要分出来：`list()` 只回能读的那些，而 `nextAccountId()` 过去只问 `list()`。
   * 于是——一条记录在，payload 却读不出来时（别人往同一个 scope 写过东西、记录被截断、
   * 旧版本留下的空壳），那个号就不在 `list()` 里 ⇒ 被判为「空闲」⇒ `write()` 上去
   * 把它**整条覆盖**。这正是 magpie `LESSONS.md` 第 9 条的形状：读不出来被当成没有，
   * 下一次写盘把真数据抹掉。所以读不出来的号要**占住**：宁可对外少显示一个账号，
   * 也不要把新账号写到它的位置上。
   */
  async #scan(family) {
    const records = await this.#credentials.listRecords()
    const accounts = []
    const reserved = []
    for (const entry of records) {
      const parsed = splitKey(entry.key)
      if (!parsed || parsed.scope !== SCOPE) continue
      if (parsed.id.endsWith('-login')) continue
      const account = parseAccountId(parsed.id)
      if (!account) continue
      if (family !== undefined && account.family !== family) continue
      const payload = await this.read(parsed.id)
      if (payload) accounts.push(payload)
      else reserved.push(parsed.id)
    }
    accounts.sort((a, b) => String(a.id).localeCompare(String(b.id)))
    return { accounts, reserved }
  }

  /** 该族下一个可用的账号 id（最小未占用序号）。 */
  async nextAccountId(family) {
    assertSegment(family, 'family')
    const { accounts, reserved } = await this.#scan(family)
    // 读得出内容的、以及读不出内容但确实占着号的，一律算已占用。
    const used = new Set([...accounts.map((account) => account.id), ...reserved])
    for (let index = 1; index < 1000; index += 1) {
      const id = `${family}-${index}`
      if (!used.has(id)) return id
    }
    throw new Error(`no free account slot left for family "${family}"`)
  }

  /** 登录临时槽位（授权流程往里写，成功后提升成正式账号）。 */
  loginSlot(family) {
    return `${assertSegment(family, 'family')}-login`
  }

  /**
   * 把登录槽位里的凭据提升成一个正式账号。
   * 返回新账号 id；槽位随后清空（删除记录）。
   */
  async promoteLoginSlot(family, { label } = {}) {
    const slot = this.loginSlot(family)
    const payload = await this.read(slot)
    if (!payload) throw new Error(`login slot "${slot}" is empty`)
    const id = await this.nextAccountId(family)
    await this.write(id, {
      ...payload,
      id,
      family,
      label: label ?? payload.label ?? payload.auth?.email ?? id,
    })
    await this.remove(slot)
    this.#log?.info?.('account-bridge: promoted %s → %s', slot, id)
    return id
  }
}

/** `dsh-account-bridge/codex-1` → `{scope, id}`。 */
function splitKey(key) {
  if (typeof key !== 'string') return undefined
  const slash = key.indexOf('/')
  if (slash <= 0) return undefined
  return { scope: key.slice(0, slash), id: key.slice(slash + 1) }
}
