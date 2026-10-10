/**
 * 「回了 2xx，但那不是 API 回复」的识别。
 *
 * 上游被 Cloudflare 挑战页挡住、回了一个登录页、回了个空 body、或者声明 JSON 却发来
 * HTML —— 这些都会带着 **200** 回来。不识别的话，我们就把网页当 SSE 解析，最后抛一个
 * 莫名其妙的错（"Unexpected token `<`"），而调用方看到的是「这族坏了」，不是「中间有个
 * 东西挡着」。识别出来之后它是**一个普通的、可以换号的失败**：换下一个账号，如实说原因。
 *
 * 只读 body 的**第一块**（不攒满 4KB）：流式响应必须尽快把控制权交回去，
 * 为了嗅探而等数据到齐会把首字延迟凭空加上去。
 *
 * 借鉴 magpie `internal/gateway/notapi.go` 的 `notAnAPIReply`
 * （MIT, Copyright (c) 2026 yetone）。见 THIRD_PARTY_NOTICES.md。
 *
 * **我们与 magpie 有一处不同**（有意为之）：magpie 只处理 2xx，非 2xx 交给它自己的
 * 分类器；而我们下方的 `httpError` 会把 `403` 直接判成 AUTH 并**把账号冷却 24 小时**。
 * 于是「Cloudflare 拦了一下」会变成「这个账号的令牌废了」——那是极其昂贵且难查的误判。
 * 所以我们对**非 2xx** 也做一条**最窄的**检查：Content-Type 是 `text/html` 且 body 真的是
 * 一个 HTML 文档开头时，判 NOT_AN_API_REPLY。返回 JSON 错误体的 401 不受影响。
 *
 * @module dsh-account-bridge/wire/assert-reply
 */

/** HTML 文档的开头。与 magpie 的 `htmlStart` 同一条。 */
const HTML_START = /^<(!doctype\s+html|html[\s>]|head[\s>]|body[\s>])/i

/** 嗅探前导空白与 BOM，对齐 magpie 的 `bytes.TrimLeft(head, " \t\r\n\ufeff")`。 */
const LEADING = /^[\s\ufeff]+/

/** 报错时附上前多少字符，够人一眼看出挡在中间的是什么。 */
const CLIP_RUNES = 200

export const NOT_AN_API_REPLY = 'NOT_AN_API_REPLY'

function headerOf(response, name) {
  const value = response?.headers?.get?.(name)
  return typeof value === 'string' ? value.toLowerCase() : ''
}

/** 造一个带稳定错误码的失败。`code` 是分类器认的那一个。 */
function notApiReply(who, why) {
  const error = new Error(`account-bridge: ${who ? `${who}: ` : ''}${why}`)
  error.code = NOT_AN_API_REPLY
  return error
}

/** 按字符（不是字节）截断，附上省略号。 */
function clipRunes(text, limit = CLIP_RUNES) {
  const runes = [...text]
  return runes.length <= limit ? text : `${runes.slice(0, limit).join('')}…`
}

/** 把「已经读掉的第一块」与「剩下的流」拼回一个 Response，调用方无从察觉。 */
function rebuilt(response, first, reader, finished) {
  if (finished) {
    // 整个 body 就只有这一块：直接给一个已结束的流，省掉一次 pump。
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(first)
        controller.close()
      },
    })
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(first)
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          controller.enqueue(value)
        }
      } catch (error) {
        controller.error(error)
        return
      }
      controller.close()
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {})
    },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

/**
 * 检查一个响应像不像 API 回复；不像就抛 `NOT_AN_API_REPLY`，像就返回一个**可以照常读**的响应。
 *
 * @param {Response} response `ctx.fetch` 的返回值
 * @param {{who?: string}} [options] `who` 会出现在错误消息最前面（族名）
 * @returns {Promise<Response>} 同一个响应，或重建后的等价物
 */
export async function assertApiReply(response, { who = '' } = {}) {
  if (!response || response.body === null || response.body === undefined) return response
  // 只有真正的 `fetch` 响应才检查得动：`Response.body` 是 ReadableStream（有 `getReader`）。
  // 测试替身常用异步生成器当 body，别的东西也可能换掉 `fetch`——对它们一律原样放行，
  // 否则这一层会从「识别网页」变成「拒绝一切非标准 fetch 实现」。
  if (typeof response.body.getReader !== 'function') return response
  if (response.status < 200 || response.status >= 300) {
    // 见文件头：只认「声明 HTML 且真的是 HTML 文档开头」这一种，防止 403 被误判成 AUTH。
    if (!headerOf(response, 'content-type').startsWith('text/html')) return response
    let text
    try {
      text = await response.text()
    } catch {
      return response
    }
    if (!HTML_START.test(text.replace(LEADING, ''))) {
      // 走到这里说明 body **已经被我们读掉了**。原样返回等于把一份读不动的响应交给下游：
      // 调用方随后 `.text()` / `.json()` 只会拿到空串（而且多半被 `.catch(() => '')` 吞掉），
      // 上游真正说了什么就永久丢了——排障时看到的是一句「没原因」的 403。
      // 所以把读到的内容装回一份等价物再还回去。
      return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers })
    }
    throw notApiReply(who, `upstream answered ${response.status} with a web page, not an API reply`)
  }
  if (response.status === 204) return response

  const contentType = headerOf(response, 'content-type')
  if (contentType.startsWith('text/html')) {
    throw notApiReply(who, `upstream answered ${response.status} with a web page (${contentType.split(';')[0]}), not an API reply`)
  }

  const reader = response.body.getReader()
  let first
  try {
    first = await reader.read()
  } catch (error) {
    // 读不出来就把原始响应还回去，让下游按它自己的方式失败（magpie 同款：
    // "a read that fails is left to the reader, as it was"）。
    return response
  }
  if (first.done) {
    throw notApiReply(who, `upstream answered ${response.status} with nothing in it, not an API reply`)
  }

  const encoding = headerOf(response, 'content-encoding')
  if (encoding !== '' && encoding !== 'identity') {
    // 压缩过的流，首字节说明不了任何事：跳过全部嗅探。
    return rebuilt(response, first.value, reader, false)
  }

  const head = Buffer.from(first.value).toString('utf8').replace(LEADING, '')
  if (HTML_START.test(head) && !contentType.includes('xml')) {
    throw notApiReply(who, `upstream answered ${response.status} with a web page (${contentType.split(';')[0] || 'no Content-Type'}), not an API reply`)
  }
  if (contentType.includes('json') && head.length > 0 && head[0] !== '{' && head[0] !== '[') {
    // 这一块可能就是全部内容，也可能不是——附上已读到的部分足够人排查。
    throw notApiReply(
      who,
      `upstream answered ${response.status} with a reply that isn't JSON, not an API reply: ${clipRunes(head.trim())}`,
    )
  }
  return rebuilt(response, first.value, reader, false)
}
