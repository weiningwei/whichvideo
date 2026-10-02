/**
 * asar 解析与"包新鲜度"校验的自检。
 *
 * 起因：green 版打包时 electron-builder 那一步失败，脚本却因为目录里已有 exe
 * 而跳过打包，结果发布出去的是旧代码 —— 用户双击后完全没反应。
 * 现在脚本会读 asar 里的 out/main/index.js 与本地编译产物比对，
 * 这里用真实 asar 结构验证解析逻辑正确。
 *
 * 运行： node scripts/test-asar-check.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const work = join(root, 'tmp', 'asar-check')

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

/**
 * 按 asar 真实格式打包一组文件。
 * 布局（与 @electron/asar 的 disk.js / pickle.js 一致）：
 *   [0..3]   外层 Pickle 的 payload 长度 = 4
 *   [4..7]   外层 Pickle 的 payload：JSON 头总长度（含 4 字节字符串长度前缀）
 *   [8..11]  内层 Pickle 的 payload 长度 = 4 + json.length
 *   [12..15] 字符串长度 = json.length
 *   [16..]   json，其后紧跟各文件内容（offset 从内容区起点算起）
 * 所以 headerSize = 4 + json.length，内容起点 = 8 + headerSize + 4。
 */
function buildAsar(files) {
  const entries = []
  let offset = 0
  for (const [filePath, content] of Object.entries(files)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    entries.push({ filePath, buf, offset })
    offset += buf.length
  }

  const rootNode = { files: {} }
  for (const entry of entries) {
    const parts = entry.filePath.split('/')
    let node = rootNode
    for (let i = 0; i < parts.length - 1; i++) {
      node.files[parts[i]] = node.files[parts[i]] ?? { files: {} }
      node = node.files[parts[i]]
    }
    node.files[parts[parts.length - 1]] = {
      size: entry.buf.length,
      offset: String(entry.offset),
      integrity: {
        algorithm: 'SHA256',
        hash: createHash('sha256').update(entry.buf).digest('hex'),
        blockSize: 4194304,
        blocks: []
      }
    }
  }

  const json = Buffer.from(JSON.stringify(rootNode), 'utf8')
  const headerSize = 4 + json.length
  const header = Buffer.alloc(16)
  header.writeUInt32LE(4, 0) // 外层 Pickle payload 长度
  header.writeUInt32LE(headerSize, 4) // 外层 Pickle payload：JSON 头总长
  header.writeUInt32LE(headerSize, 8) // 内层 Pickle payload 长度
  header.writeUInt32LE(json.length, 12) // 字符串长度
  return Buffer.concat([header, json, ...entries.map((e) => e.buf)])
}

async function main() {
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })

  const mod = await import(pathToFileURL(join(root, 'scripts', 'build-portable-folder.mjs')).href)
  check('打包脚本导出了 readAsarEntry', typeof mod.readAsarEntry === 'function')

  const mainSource = 'console.log("未找到 preload 产物")\nmodule.exports = {}\n'
  const asarPath = join(work, 'app.asar')
  writeFileSync(
    asarPath,
    buildAsar({
      'package.json': JSON.stringify({ main: './out/main/index.js' }),
      'out/main/index.js': mainSource,
      'out/preload/index.mjs': 'export {}\n',
      'out/renderer/index.html': '<!doctype html>'
    })
  )
  check('构造出的 asar 文件存在', existsSync(asarPath))

  const mainEntry = mod.readAsarEntry(asarPath, 'out/main/index.js')
  check('能读出嵌套路径的文件', mainEntry !== null && mainEntry.length > 0, `${mainEntry?.length ?? 0} 字节`)
  check('读出的内容与写入一致', mainEntry?.toString('utf8') === mainSource)

  const pkgEntry = mod.readAsarEntry(asarPath, 'package.json')
  check('能读出顶层文件', pkgEntry?.toString('utf8').includes('out/main/index.js') === true)

  check('不存在的路径返回 null', mod.readAsarEntry(asarPath, 'out/nope.js') === null)

  const rendererEntry = mod.readAsarEntry(asarPath, 'out/renderer/index.html')
  check('第三个层级也能解析', rendererEntry?.toString('utf8') === '<!doctype html>')

  rmSync(work, { recursive: true, force: true })
  console.log(`\n=== asar 校验逻辑：${passed}/${passed + failed} 通过 ===`)
  void readFileSync
  if (failed) process.exit(1)
}

main()
