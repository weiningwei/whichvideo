import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const source = readFileSync(resolve('src/renderer/src/lib/ipc-contract.ts'), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const { decodeResponse, decodeEvent, responses } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

let passed = 0
function check(name, action) {
  action()
  passed++
  console.log(`  ✓ ${name}`)
}
function rejects(action) {
  let failed = false
  try { action() } catch { failed = true }
  if (!failed) throw new Error('无效数据未被拒绝')
}

const video = {
  id: 1, path: 'C:\\videos\\a.mp4', pathKey: 'c:\\videos\\a.mp4', name: 'a.mp4', dir: 'C:\\videos', ext: '.mp4',
  size: 100, mtimeMs: 1, duration: 10, width: 320, height: 180, videoCodec: 'h264',
  frameCount: 2, status: 'ready', error: null, addedAt: 1, indexedAt: 2, folderId: null,
  processedTimestamps: [1000, 2000], samplingOverride: null, processedMs: 100, fileHash: null
}
const search = {
  query: { width: 1, height: 1, colorScoreHint: 0.1 }, matchCount: 0,
  comparedFrames: 0, elapsedMs: 1, found: false, matches: []
}

check('38 个命令都有返回值校验器', () => {
  const ipcBlock = readFileSync(resolve('src/shared/types.ts'), 'utf8').match(/export const IPC = \{([\s\S]*?)\} as const/)?.[1] ?? ''
  const channels = [...ipcBlock.matchAll(/^\s*\w+: '(\w+)'/gm)]
    .map((match) => match[1]).filter((name) => name !== 'library_event')
  if (channels.length !== 39 || channels.some((name) => !(name in responses))) throw new Error('命令校验器不齐')
})
check('媒体工具重检返回生效路径与手动目录', () => {
  const status = { ready: true, source: 'environment', directory: 'D:\\tools', configuredDirectory: 'E:\\manual', ffmpeg: 'D:\\tools\\ffmpeg.exe', ffprobe: 'D:\\tools\\ffprobe.exe', message: '环境变量' }
  if (decodeResponse('library_refresh_media_tools', status).configuredDirectory !== 'E:\\manual') throw new Error('正确值被拒绝')
  rejects(() => decodeResponse('library_refresh_media_tools', { ...status, configuredDirectory: undefined }))
})
check('重新索引要求 count 对象，数字与缺失字段会报错', () => {
  if (decodeResponse('videos_reindex', { count: 1 }).count !== 1) throw new Error('正确值被拒绝')
  rejects(() => decodeResponse('videos_reindex', 1))
  rejects(() => decodeResponse('videos_reindex', {}))
})
check('导入结果字段缺失时立即报错', () => {
  const result = { added: 1, duplicates: 0, skipped: 0, failed: 0, scanned: 1, folders: 0 }
  if (decodeResponse('videos_import', result).added !== 1) throw new Error('正确值被拒绝')
  rejects(() => decodeResponse('videos_import', { ...result, failed: undefined }))
})
check('视频列表和事件共用完整视频记录校验', () => {
  decodeResponse('videos_list', { total: 1, items: [video] })
  decodeEvent({ type: 'video-updated', video })
  rejects(() => decodeResponse('videos_list', { total: 1, items: [{ ...video, frameCount: undefined }] }))
  rejects(() => decodeEvent({ type: 'video-updated', video: { ...video, status: 'unknown' } }))
})
check('剪贴板响应必须提供图片字符串', () => {
  decodeResponse('search_clipboard', { dataUrl: 'data:image/png;base64,AA==', response: search })
  rejects(() => decodeResponse('search_clipboard', { dataUrl: null, response: search }))
})
check('事件字段名错误时拒绝，空返回值兼容 Tauri null', () => {
  rejects(() => decodeEvent({ type: 'video-removed', video_id: 1, path: 'a.mp4' }))
  decodeResponse('videos_remove', null)
})

console.log(`\nIPC 返回值与事件校验：${passed}/${passed} 通过`)
