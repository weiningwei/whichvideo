/**
 * 链接取图的纯逻辑自检（不联网、不依赖 Electron）。
 *
 * 覆盖 url-image.ts 里可离线验证的部分：
 *   · pickImageFromHtml：网页主图解析（og:image / twitter:image / link /
 *     首个 <img>，含相对地址转绝对、占位图跳过）
 *   · fetchImageFromUrl 的协议校验：只放行 http/https，挡掉 file:、data:、
 *     javascript:、ftp: 等——这是"贴个链接"不至于变成任意本地文件读取的关键
 *   · describeUrlForLog 的日志标识
 *
 * 联网部分（真实 fetch、超时、体积上限、重定向）不在此脚本覆盖，
 * 由 test:core 之外的手工验证与真实使用检验。
 *
 * 运行： node scripts/build-core.mjs && node scripts/test-url-image.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const modPath = join(root, 'out-e2e', 'main', 'url-image.js')

let failed = 0
let passed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const PAGE = 'https://example.com/show/episode-1'

async function main() {
  if (!existsSync(modPath)) {
    console.error(`找不到 ${modPath}，请先运行 node scripts/build-core.mjs`)
    process.exit(1)
  }
  const { pickImageFromHtml, fetchImageFromUrl, describeUrlForLog } = await import(
    pathToFileURL(modPath).href
  )

  console.log('=== 网页主图解析 pickImageFromHtml ===')

  check(
    '优先取 og:image',
    pickImageFromHtml(
      `<html><head><meta property="og:image" content="https://cdn.example.com/poster.jpg"></head>
       <body><img src="https://cdn.example.com/first.jpg"></body></html>`,
      PAGE
    ) === 'https://cdn.example.com/poster.jpg',
    'og:image 优先于 <img>'
  )
  check(
    'og:image 为相对地址时按页面 URL 解析为绝对',
    pickImageFromHtml(
      `<meta property="og:image" content="/img/cover.png">`,
      PAGE
    ) === 'https://example.com/img/cover.png',
    '/img/cover.png → https://example.com/img/cover.png'
  )
  check(
    '没有 og:image 时取 twitter:image',
    pickImageFromHtml(
      `<meta name="twitter:image" content="https://cdn.example.com/tw.jpg">`,
      PAGE
    ) === 'https://cdn.example.com/tw.jpg'
  )
  check(
    'og:image 缺失时取 link[rel=image_src]',
    pickImageFromHtml(
      `<link rel="image_src" href="https://cdn.example.com/src.jpg">`,
      PAGE
    ) === 'https://cdn.example.com/src.jpg'
  )
  check(
    '都没有时取首个 <img src>',
    pickImageFromHtml(
      `<body><img src="https://cdn.example.com/a.jpg"><img src="https://cdn.example.com/b.jpg"></body>`,
      PAGE
    ) === 'https://cdn.example.com/a.jpg',
    '第一张 <img>'
  )
  check(
    '单个引号的属性也能解析',
    pickImageFromHtml(`<meta property='og:image' content='https://cdn.example.com/q.png'>`, PAGE) ===
      'https://cdn.example.com/q.png'
  )
  check(
    '属性顺序颠倒也能解析（content 在前）',
    pickImageFromHtml(`<meta content="https://cdn.example.com/r.png" property="og:image">`, PAGE) ===
      'https://cdn.example.com/r.png'
  )
  check(
    '跳过 data: 内联图',
    pickImageFromHtml(
      `<body><img src="data:image/png;base64,iVBOR"><img src="https://cdn.example.com/real.jpg"></body>`,
      PAGE
    ) === 'https://cdn.example.com/real.jpg'
  )
  check(
    '跳过占位图（spacer/placeholder/1x1 等）',
    pickImageFromHtml(
      `<body><img src="https://cdn.example.com/spacer.gif"><img src="https://cdn.example.com/1x1.png">
       <img src="https://cdn.example.com/real.jpg"></body>`,
      PAGE
    ) === 'https://cdn.example.com/real.jpg'
  )
  check(
    '<img> 用相对地址时同样转绝对',
    pickImageFromHtml(`<body><img src="thumb/big.jpg"></body>`, PAGE) ===
      'https://example.com/show/thumb/big.jpg',
    '相对路径按页面所在目录解析'
  )
  check(
    '网页里没有任何图片时返回 null',
    pickImageFromHtml('<html><body><p>纯文字页面</p></body></html>', PAGE) === null
  )
  check(
    '空 HTML 返回 null',
    pickImageFromHtml('', PAGE) === null
  )
  check(
    'og:image 内容为空串时继续往下找',
    pickImageFromHtml(
      `<meta property="og:image" content=""><img src="https://cdn.example.com/fallback.jpg">`,
      PAGE
    ) === 'https://cdn.example.com/fallback.jpg'
  )

  console.log('')
  console.log('=== 协议校验（安全边界）===')
  const reject = [
    ['file: 协议', 'file:///C:/Windows/System32/config/SAM', 'unsupported-protocol'],
    ['file: 本地图片', 'file:///E:/secret.png', 'unsupported-protocol'],
    ['data: 内联数据', 'data:image/png;base64,iVBORw0KGgo=', 'unsupported-protocol'],
    ['javascript: 伪协议', 'javascript:alert(1)', 'unsupported-protocol'],
    ['ftp: 协议', 'ftp://example.com/a.jpg', 'unsupported-protocol'],
    ['chrome: 协议', 'chrome://settings', 'unsupported-protocol'],
    ['无协议的裸路径', 'E:\\Media\\poster.jpg', 'unsupported-protocol'],
    ['空字符串', '', 'invalid-input'],
    ['纯空格', '   ', 'invalid-input']
  ]
  for (const [label, input, expectCode] of reject) {
    const res = await fetchImageFromUrl(input)
    check(
      `拒绝 ${label}`,
      res.ok === false && res.code === expectCode && !!res.message,
      `code=${res.ok ? '(成功)' : res.code} — ${res.message}`
    )
  }
  check(
    '拒绝时明确说明是协议问题',
    (await fetchImageFromUrl('file:///C:/x.png')).message.includes('只支持 http'),
    '提示只支持 http / https'
  )
  // 错误码必须是 shared/result.ts 枚举里的成员——防止调用点手写拼错的字符串
  //（TS 编译期拦得住模块内，拦不住测试里的期望值）。
  {
    const sharedSrc = readFileSync(join(root, 'src', 'shared', 'result.ts'), 'utf8')
    const enumBlock = sharedSrc.match(/export type ErrorCode =([\s\S]*?)\n\n/)?.[1] ?? ''
    const defined = new Set([...enumBlock.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]))
    const expectCodes = reject.map(([, , code]) => code)
    check(
      '测试里的期望错误码都在 ErrorCode 枚举里',
      expectCodes.length > 0 && expectCodes.every((c) => defined.has(c)),
      expectCodes.filter((c) => !defined.has(c)).join(', ') || `${expectCodes.length} 个均合法`
    )
  }

  console.log('')
  console.log('=== 日志标识 describeUrlForLog ===')
  const okRes = {
    ok: true,
    data: Buffer.from('fake-png-bytes'),
    contentType: 'image/png',
    finalUrl: 'https://cdn.example.com/poster.jpg'
  }
  const logLine = describeUrlForLog(okRes)
  check('成功时含文件名与体积', logLine.includes('poster.jpg') && logLine.includes('14B'), logLine)
  check(
    '失败时给出原因',
    describeUrlForLog({ ok: false, code: 'timeout', message: '超时' }).includes('超时'),
    '失败(超时)'
  )
  // 同样的字节应得到同样的指纹，便于日志里区分两次不同的请求
  const sameHash = describeUrlForLog(okRes) === describeUrlForLog({ ...okRes })
  check('相同内容得到相同标识（可据此区分不同请求）', sameHash)

  console.log(`\n=== 链接取图：${passed}/${passed + failed} 通过 ===`)
  if (failed) process.exit(1)
}

main()
