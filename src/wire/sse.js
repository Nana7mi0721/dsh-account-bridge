/**
 * 极小的 SSE 解析器（用于 Responses API / Anthropic Messages 的流式响应）。
 *
 * 只做该做的事：按行切、累积 `event:` / `data:`、空行派发。不做重连、不做
 * `Last-Event-ID`——上游这几家都不需要，重试由 DSH 的重试策略兜。
 * @module dsh-account-bridge/wire/sse
 */

/**
 * 把 fetch 的 Response body 逐事件吐出来。
 *
 * @param {Response} response 已确认 ok 的响应
 * @param {{signal?: AbortSignal, onComment?: (text: string) => void}} [options]
 * @returns {AsyncGenerator<{event: string, data: string, raw: string}>}
 */
export async function* readSse(response, options = {}) {
  const { signal, onComment } = options
  const body = response.body
  if (!body) throw new Error('SSE: response has no body')

  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let event = ''
  let data = ''

  const flush = () => {
    if (data.length === 0 && event.length === 0) return undefined
    const payload = { event: event || 'message', data, raw: data }
    event = ''
    data = ''
    return payload
  }

  const consumeLine = (line) => {
    if (line === '') return flush()
    if (line.startsWith(':')) {
      onComment?.(line.slice(1).trim())
      return undefined
    }
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data = data.length === 0 ? value : `${data}\n${value}`
    return undefined
  }

  const iterator = body[Symbol.asyncIterator]
    ? body[Symbol.asyncIterator]()
    : body.getReader
      ? readerIterator(body.getReader())
      : undefined
  if (!iterator) throw new Error('SSE: response body is not readable')

  try {
    while (true) {
      if (signal?.aborted) return
      const { value, done } = await iterator.next()
      if (done) break
      const chunk = typeof value === 'string' ? value : decoder.decode(value, { stream: true })
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        let line = buffer.slice(0, index)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        buffer = buffer.slice(index + 1)
        const payload = consumeLine(line)
        if (payload) yield payload
        index = buffer.indexOf('\n')
      }
    }
    // 流结束：把残留当成最后一批处理（有些上游不发结尾空行）
    if (buffer.length > 0) {
      for (const line of buffer.split('\n')) {
        const payload = consumeLine(line.endsWith('\r') ? line.slice(0, -1) : line)
        if (payload) yield payload
      }
    }
    const tail = flush()
    if (tail) yield tail
  } finally {
    try {
      await iterator.return?.()
    } catch {
      /* 取消时的清理失败不影响结果 */
    }
  }
}

/** 把 web ReadableStream 的 reader 包成 async iterator。 */
async function* readerIterator(reader) {
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* ignore */
    }
  }
}
