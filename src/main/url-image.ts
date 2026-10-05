/**
 * 从网页链接取图：把一个 http(s) URL 变成可算指纹的 PNG 字节。
 *
 * 为什么不直接用渲染端的 <img>：跨域限制 + Canvas 取像素会被污染，且大图需先下载。
 * 这里在主进程用 Node 的 fetch 拿到字节，再交给 nativeImage 解码，与
 * 拖拽 / 粘贴 / 选文件三条既有输入最终汇入同一条链路。
 *
 * 两种情况：
 *   1. 图片直链（Content-Type: image/*）—— 直接用响应体
 *   2. 网页（Content-Type: text/html）—— 依次尝试
 *      a) <meta property="og:image">（社交卡片图，绝大多数分享链接都有）
 *      b) <link rel="image_src"> / <img src> 的第一张
 *      取到后把相对地址按原页面 URL 解析成绝对地址，再请求一次
 *
 * 防护（都是为了不让"贴个链接"变成意外的文件读取或内存炸弹）：
 *   · 只允许 http: / https:，挡掉 file:、data:、ftp: 等
 *   · 响应体上限 10 MB，超出即中止
 *   · 15 秒超时，最多跟随 5 跳重定向
 *   · 抓网页时最多再看 1 层图片链接，不递归
 */
import { createHash } from 'node:crypto'
import { MAX_BYTES, TIMEOUT_MS, MAX_REDIRECTS, MAX_IMAGE_FETCHES, USER_AGENT } from './constants'

export interface FetchImageResult {
  ok: boolean
  /** 成功时为 PNG/原始格式的字节；失败时为空 */
  data: Buffer | null
  /** 图片类型（image/png 等），仅成功时有值 */
  contentType: string | null
  /** 最终实际取图的地址（可能与请求地址不同：重定向或从网页里解析出的图片） */
  finalUrl: string | null
  /** 失败原因 / 成功路径的简短说明，直接展示给用户 */
  message: string
}

function failure(message: string, finalUrl: string | null = null): FetchImageResult {
  return { ok: false, data: null, contentType: null, finalUrl, message }
}

/** 只放行 http/https，顺带挡掉 javascript: 之类的伪协议 */
function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** fetchBytes 的返回：用可辨识联合（discriminated union）让 `ok` 能窄化出对应字段 */
type FetchOutcome =
  | { ok: true; bytes: Buffer; contentType: string; finalUrl: string }
  | { ok: false; message: string }

/**
 * 带超时与体积上限的 fetch。手动处理重定向以便计数——
 * fetch 的 redirect: 'manual' 在跨协议时行为不一致，索性自己跳。
 */
async function fetchBytes(url: string): Promise<FetchOutcome> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(current, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          // 一些图床会按 UA 拒绝空 UA；这里表明是一个普通的桌面应用
          'User-Agent': USER_AGENT,
          Accept: 'image/*,text/html;q=0.9,*/*;q=0.8'
        }
      })

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) return { ok: false, message: `重定向缺少 Location（HTTP ${res.status}）` }
        // 每一跳都要重新校验，防止重定向到 file: 之类
        const next = new URL(location, current).toString()
        if (!isHttpUrl(next)) return { ok: false, message: '重定向到了不支持的协议' }
        current = next
        continue
      }

      if (!res.ok) {
        return { ok: false, message: `HTTP ${res.status} ${res.statusText}`.trim() }
      }

      const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()

      // 先看 Content-Length，超了直接拒绝，不必真去下载
      const declared = Number(res.headers.get('content-length') ?? '')
      if (Number.isFinite(declared) && declared > MAX_BYTES) {
        return { ok: false, message: `图片过大（${(declared / 1024 / 1024).toFixed(1)} MB，上限 10 MB）` }
      }

      // 流式读取，边读边累加，超限立刻掐断——避免"声明小实际大"的情况
      const reader = res.body?.getReader()
      if (!reader) return { ok: false, message: '响应没有可读的响应体' }
      const chunks: Buffer[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > MAX_BYTES) {
          await reader.cancel().catch(() => undefined)
          return { ok: false, message: '图片过大（超过 10 MB 上限）' }
        }
        chunks.push(Buffer.from(value))
      }
      if (total === 0) return { ok: false, message: '响应体为空' }

      return { ok: true, bytes: Buffer.concat(chunks), contentType, finalUrl: current }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('abort') || msg.includes('AbortError')) {
        return { ok: false, message: `请求超时（${TIMEOUT_MS / 1000} 秒）` }
      }
      return { ok: false, message: `请求失败：${msg}` }
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: false, message: `重定向超过 ${MAX_REDIRECTS} 跳` }
}

const IMG_EXT = /\.(jpe?g|png|webp|bmp|gif|avif|jfif)(?:$|[?#])/i

/**
 * 从 HTML 里挑一个最可能的主图地址。
 * 优先级：og:image → twitter:image → link[rel=image_src] → 第一个 <img src>。
 */
export function pickImageFromHtml(html: string, baseUrl: string): string | null {
  const metaPatterns = [
    /<meta[^>]+property\s*=\s*["']og:image["'][^>]*>/i,
    /<meta[^>]+name\s*=\s*["']twitter:image["'][^>]*>/i
  ]
  for (const re of metaPatterns) {
    const tag = html.match(re)?.[0]
    if (!tag) continue
    const content = tag.match(/content\s*=\s*["']([^"']+)["']/i)?.[1]
    if (content?.trim()) {
      try {
        return new URL(content.trim(), baseUrl).toString()
      } catch {
        /* 继续找下一张 */
      }
    }
  }

  const linkSrc = html.match(/<link[^>]+rel\s*=\s*["']image_src["'][^>]*>/i)?.[0]
  if (linkSrc) {
    const href = linkSrc.match(/href\s*=\s*["']([^"']+)["']/i)?.[1]
    if (href?.trim()) {
      try {
        return new URL(href.trim(), baseUrl).toString()
      } catch {
        /* 落到下面的 img 扫描 */
      }
    }
  }

  // 扫描所有 <img src>，跳过明显的占位图与 data: 内联图
  for (const m of html.matchAll(/<img[^>]+src\s*=\s*["']([^"']+)["']/gi)) {
    const src = m[1]?.trim()
    if (!src || src.startsWith('data:')) continue
    if (/(spacer|blank|placeholder|1x1|pixel|loading|transparent)/i.test(src)) continue
    try {
      return new URL(src, baseUrl).toString()
    } catch {
      continue
    }
  }
  return null
}

/**
 * 主入口：URL → 图片字节。
 * 图片直链一步到位；网页则解析出主图地址再请求一次。
 */
export async function fetchImageFromUrl(rawUrl: string): Promise<FetchImageResult> {
  const input = rawUrl.trim()
  if (!input) return failure('请输入图片链接')
  if (!isHttpUrl(input)) {
    return failure('只支持 http / https 开头的链接')
  }

  const first = await fetchBytes(input)
  if (!first.ok) return failure(first.message, input)

  // 情况一：直接就是图片
  if (first.contentType.startsWith('image/')) {
    return {
      ok: true,
      data: first.bytes,
      contentType: first.contentType,
      finalUrl: first.finalUrl,
      message: `已获取图片（${(first.bytes.length / 1024).toFixed(0)} KB）`
    }
  }

  // 非图片也不像网页：有些站点会返回 application/octet-stream，用扩展名兜一下
  if (IMG_EXT.test(first.finalUrl) && !first.contentType.startsWith('text/html')) {
    return {
      ok: true,
      data: first.bytes,
      contentType: first.contentType || 'image/jpeg',
      finalUrl: first.finalUrl,
      message: `已获取图片（${(first.bytes.length / 1024).toFixed(0)} KB）`
    }
  }

  if (!first.contentType.includes('html') && !first.contentType.includes('text/')) {
    return failure(
      `该链接返回的不是图片（Content-Type: ${first.contentType || '未知'}）`,
      first.finalUrl
    )
  }

  // 情况二：网页，解析主图
  let html: string
  try {
    html = new TextDecoder('utf-8', { fatal: false }).decode(first.bytes)
  } catch {
    return failure('网页内容解码失败', first.finalUrl)
  }

  const imageUrl = pickImageFromHtml(html, first.finalUrl)
  if (!imageUrl) {
    return failure('这个网页里没找到图片（og:image 与 <img> 都没有）', first.finalUrl)
  }

  // 解析出的地址可能与原页同域也可能跨域，只再取一次，不再递归
  for (let i = 1; i < MAX_IMAGE_FETCHES; i++) {
    if (!isHttpUrl(imageUrl)) break
    const img = await fetchBytes(imageUrl)
    if (!img.ok) return failure(`找到主图但下载失败：${img.message}`, imageUrl)
    if (img.contentType.startsWith('image/')) {
      return {
        ok: true,
        data: img.bytes,
        contentType: img.contentType,
        finalUrl: img.finalUrl,
        message: `已从网页取到主图（${(img.bytes.length / 1024).toFixed(0)} KB）`
      }
    }
    break
  }

  return failure('找到的地址仍然不是图片，请直接贴图片直链', imageUrl)
}

/** 给日志用的短标识：取文件名并附内容指纹前 8 位，便于区分两次请求 */
export function describeUrlForLog(result: FetchImageResult): string {
  if (!result.ok) return `失败(${result.message})`
  const bytes = result.data ?? Buffer.alloc(0)
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
  const name = (() => {
    try {
      return new URL(result.finalUrl ?? '').pathname.split('/').filter(Boolean).pop() ?? '(无文件名)'
    } catch {
      return '(无文件名)'
    }
  })()
  return `${name} ${bytes.length}B #${hash}`
}
