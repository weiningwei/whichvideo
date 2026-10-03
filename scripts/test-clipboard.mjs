/**
 * 剪贴板选图逻辑的单元测试（src/main/clipboard.ts）。
 *
 * 起因：界面上点「使用剪贴板图片」提示"剪贴板里没有图片"，但截图明明在剪贴板里。
 * 根因是旧实现先 `clipboard.has('image/png')` 卡了一道白名单，Windows 上只放
 * image/bmp(DIB) / image/jpeg 的来源（画图、部分浏览器、Office、聊天软件）全被挡掉。
 * 这里把那类来源钉死，防止白名单被无意间加回来。
 *
 * 运行： node scripts/build-core.mjs && node scripts/test-clipboard.mjs
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const out = join(root, 'out-e2e')

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

/** 假剪贴板：items 是 { types, payloads } 形状，payloads 可以是 Blob / 字符串 / 抛错 */
function fakeClipboard(items) {
  return {
    async read() {
      return items.map((item) => ({
        types: item.types,
        async getType(type) {
          const value = item.payloads?.[type]
          if (value === undefined) throw new Error(`没有 ${type}`)
          if (value instanceof Error) throw value
          return value
        }
      }))
    }
  }
}

function collect() {
  const logs = []
  const errors = []
  return {
    logs,
    errors,
    logger: {
      log: (m) => logs.push(m),
      logError: (scope, err) => errors.push(`${scope}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

const bytes = (n) => new Uint8Array(Array.from({ length: n }, (_, i) => (i % 251) + 1))

async function main() {
  const compiled = join(out, 'main', 'clipboard.js')
  if (!existsSync(compiled)) {
    console.error('请先运行 node scripts/build-core.mjs')
    process.exit(1)
  }
  const { readClipboardImageBytes } = await import(pathToFileURL(compiled).href)

  console.log('=== 1. 选图规则 ===')

  // 回归核心：没有 image/png，只有 image/bmp —— 旧实现在这里直接返回 null
  {
    const clip = fakeClipboard([{ types: ['image/bmp'], payloads: { 'image/bmp': new Blob([bytes(16)]) } }])
    const got = await readClipboardImageBytes(clip, collect().logger)
    check('只有 image/bmp 也能读到（不能加 PNG 白名单）', got?.type === 'image/bmp', got?.type ?? 'null')
    check('读到的字节数正确', got?.buffer.length === 16, String(got?.buffer.length))
  }

  {
    const clip = fakeClipboard([
      {
        types: ['text/plain', 'image/png'],
        payloads: { 'text/plain': 'hi', 'image/png': new Blob([bytes(8)]) }
      }
    ])
    const got = await readClipboardImageBytes(clip, collect().logger)
    check('同一项里混有 text/plain 时仍挑出图片', got?.type === 'image/png', got?.type ?? 'null')
  }

  {
    const clip = fakeClipboard([
      { types: ['image/jpeg'], payloads: { 'image/jpeg': new Blob([bytes(4)]) } },
      { types: ['image/png'], payloads: { 'image/png': new Blob([bytes(12)]) } }
    ])
    const got = await readClipboardImageBytes(clip, collect().logger)
    check('按剪贴板顺序取第一张可用图片', got?.type === 'image/jpeg', got?.type ?? 'null')
  }

  console.log('\n=== 2. 解析失败要跳到下一张，而不是整体失败 ===')
  {
    const clip = fakeClipboard([
      {
        types: ['image/webp'],
        payloads: { 'image/webp': new Error('损坏的数据') }
      },
      { types: ['image/png'], payloads: { 'image/png': new Blob([bytes(6)]) } }
    ])
    const env = collect()
    const got = await readClipboardImageBytes(clip, env.logger)
    check('第一张解析失败会落到第二张', got?.type === 'image/png', got?.type ?? 'null')
    check('失败原因记进了日志', env.errors.length === 1 && /剪贴板图片解析/.test(env.errors[0]), env.errors[0] ?? '')
  }

  {
    const clip = fakeClipboard([
      { types: ['image/png'], payloads: { 'image/png': new Blob([new Uint8Array(0)]) } },
      { types: ['image/jpeg'], payloads: { 'image/jpeg': new Blob([bytes(3)]) } }
    ])
    const got = await readClipboardImageBytes(clip, collect().logger)
    check('空图片会被跳过', got?.type === 'image/jpeg', got?.type ?? 'null')
  }

  {
    const clip = fakeClipboard([{ types: ['image/png'], payloads: { 'image/png': 'not-a-blob' } }])
    const got = await readClipboardImageBytes(clip, collect().logger)
    check('非 Blob 内容被跳过且返回 null', got === null, JSON.stringify(got))
  }

  console.log('\n=== 3. 没有图片时要给出可诊断的日志，且不抛异常 ===')
  {
    const clip = fakeClipboard([{ types: ['text/plain'], payloads: { 'text/plain': 'hello' } }])
    const env = collect()
    const got = await readClipboardImageBytes(clip, env.logger)
    check('纯文本剪贴板返回 null', got === null)
    check(
      '日志里写出了剪贴板当前格式',
      env.logs.some((l) => l.includes('text/plain') && l.includes('剪贴板里没有可用图片')),
      env.logs[0] ?? ''
    )
    check('没有误报错误', env.errors.length === 0, env.errors.join(' | '))
  }

  {
    const clip = {
      read() {
        return Promise.reject(new Error('拒绝访问'))
      }
    }
    const env = collect()
    const got = await readClipboardImageBytes(clip, env.logger)
    check('剪贴板读取抛错时返回 null 而不是冒泡', got === null)
    check('抛错原因记进了日志', env.errors.length === 1 && /拒绝访问/.test(env.errors[0]), env.errors[0] ?? '')
  }

  {
    const clip = fakeClipboard([])
    const env = collect()
    const got = await readClipboardImageBytes(clip, env.logger)
    check('空剪贴板返回 null', got === null)
    check(
      '空剪贴板的日志标注格式为空',
      env.logs.some((l) => l.includes('空')),
      env.logs[0] ?? ''
    )
  }

  console.log(`\n=== 剪贴板选图自检：${passed}/${passed + failed} 通过 ===`)
  if (failed) process.exit(1)
}

try {
  await main()
} catch (err) {
  console.error('\n剪贴板自检自身抛错：')
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exit(1)
}
