/**
 * 通用小工具：脱敏、base64url、JSON、时间。
 * @module dsh-account-bridge/util
 */

const SECRET_PATTERNS = [
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<jwt>'],
  [/ya29\.[A-Za-z0-9_-]{10,}/g, '<google-token>'],
  [/\bsk-[A-Za-z0-9_-]{10,}/g, '<api-key>'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, 'Bearer <redacted>'],
  [/"?(access_token|refresh_token|id_token|api_key|apiKey|authorization|client_secret)"?\s*[:=]\s*"?[^"\s,}]{8,}"?/gi, '$1=<redacted>'],
]

/** 把任意字符串里的疑似 token 抹掉，用于日志与错误消息。 */
export function redact(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  let out = value
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** 深度脱敏（对象版），只处理字符串叶子。 */
export function redactDeep(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item, depth + 1)
    return out
  }
  return value
}

/** base64url 编码（无 padding），PKCE 与 JWT 解析用。 */
export function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 解码 JWT 的 payload 段（不做签名校验，仅用于读 claim）。 */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 安全解析 JSON，失败返回 undefined。 */
export function tryJson(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 从一批候选字段里取第一个正数，用于「重置秒数」这类多命名兼容。 */
export function firstPositiveNumber(source, keys) {
  if (!source || typeof source !== 'object') return undefined
  for (const key of keys) {
    const raw = source[key]
    const value = typeof raw === 'string' ? Number(raw) : raw
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

/** 截断长文本用于日志。 */
export function clamp(value, max = 400) {
  if (typeof value !== 'string') return value
  return value.length <= max ? value : `${value.slice(0, max)}…(+${value.length - max})`
}

/** 生成一个短随机 id。 */
export function randomId(bytes = 16) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

/**
 * 把「这份登录态是从哪个文件来的」记进账号记录。
 *
 * 统一发现的指纹优先用 `sourcePath`（见 `src/discover.js` 的 `identityMaterial`），
 * 所以导入进来的记录必须带上它——不带的话，拿记录重算指纹只能退到会轮换的令牌上，
 * 于是「已经导入过」永远判不出来，每次扫描都会再插一个重复账号。
 */
export function withSource(record, item) {
  return typeof item?.sourcePath === 'string' && item.sourcePath.length > 0
    ? { ...record, sourcePath: item.sourcePath }
    : record
}

/** 延时，可被 AbortSignal 打断。 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}
