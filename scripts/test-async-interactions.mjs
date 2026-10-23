/** 用可控的后端响应验证刷新失败、重试、分页取消和链接输入保留。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

async function loadTypeScript(path) {
  const source = readFileSync(resolve(path), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
}

const { loadLibrarySnapshot, loadVideoPages } = await loadTypeScript('src/renderer/src/lib/libraryRefresh.ts')
const { urlInputAfterSearch } = await loadTypeScript('src/renderer/src/lib/searchUrlInput.ts')

let failStats = true
const api = {
  library: {
    stats: async () => { if (failStats) throw new Error('数据库暂时不可用'); return { videos: 2 } },
    status: async () => ({ running: false }),
    settings: async () => ({ samplingMode: 'uniform' }),
    dataDir: async () => ({ dir: 'data' }),
    mediaTools: async () => ({ ready: true })
  },
  folders: { list: async () => [{ id: 1 }] }
}
await assert.rejects(loadLibrarySnapshot(api), /数据库暂时不可用/)
failStats = false
const snapshot = await loadLibrarySnapshot(api)
assert.equal(snapshot.stats.videos, 2)
assert.equal(snapshot.folders[0].id, 1)
console.log('  ✓ 首页数据失败后重试可取得完整快照')

const videos = Array.from({ length: 1100 }, (_, id) => ({ id }))
let failSecondPage = true
const offsets = []
const list = async ({ offset, limit }) => {
  offsets.push(offset)
  if (offset === 500 && failSecondPage) { failSecondPage = false; throw new Error('第二页读取失败') }
  return { total: videos.length, items: videos.slice(offset, offset + limit) }
}
await assert.rejects(loadVideoPages(list, { status: 'all' }, () => true), /第二页读取失败/)
const page = await loadVideoPages(list, { status: 'all' }, () => true)
assert.equal(page.items.length, 1100)
assert.deepEqual(offsets, [0, 500, 0, 500, 1000])
console.log('  ✓ 分页读取失败后从第一页重新取得完整列表')

let current = true
let requests = 0
const cancelled = await loadVideoPages(async ({ offset, limit }) => {
  requests++
  current = false
  return { total: videos.length, items: videos.slice(offset, offset + limit) }
}, {}, () => current)
assert.equal(cancelled, null)
assert.equal(requests, 1)
console.log('  ✓ 查询被替换后停止拉取旧查询')

const failed = { ok: false, error: '链接不可访问' }
const succeeded = { ok: true, error: null }
assert.equal(urlInputAfterSearch('https://example.com/a.jpg', 'https://example.com/a.jpg', failed), 'https://example.com/a.jpg')
assert.equal(urlInputAfterSearch('https://example.com/a.jpg', 'https://example.com/a.jpg', succeeded), '')
assert.equal(urlInputAfterSearch('https://example.com/b.jpg', 'https://example.com/a.jpg', succeeded), 'https://example.com/b.jpg')
console.log('  ✓ 链接失败保留输入，成功清除本次链接且不覆盖新输入')
