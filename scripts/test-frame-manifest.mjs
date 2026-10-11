/**
 * 回归测试：db.listFrameManifest 必须返回驼峰字段（frameIndex / timeMs），
 * 而不是 better-sqlite3 默认给的蛇形列名（frame_index / time_ms）。
 *
 * 历史 bug：as cast 撒谎，IPC 拿到 undefined，FrameGallery 显示 NaN/NaN-NaN:NaN.NaN。
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const work = join('tmp', '__dbg_manifest')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const dbPath = join(work, 'test.db')
const raw = new Database(dbPath)
raw.exec(`
  CREATE TABLE frames (
    video_id INTEGER NOT NULL,
    frame_index INTEGER NOT NULL,
    time_ms INTEGER NOT NULL,
    dhash BLOB, struct BLOB, color BLOB, spatial BLOB,
    PRIMARY KEY (video_id, frame_index)
  )
`)
// 预设 user_version = 当前 FRAME_FORMAT_VERSION，否则 LibraryDatabase 的
// migrate() 会按"格式不兼容"清空我们刚插的测试数据。
raw.pragma(`user_version = 5`)
const ins = raw.prepare(
  'INSERT INTO frames (video_id, frame_index, time_ms, dhash, struct, color, spatial) VALUES (?, ?, ?, ?, ?, ?, ?)'
)
const empty = Buffer.alloc(0)
ins.run(1, 0, 1500, empty, empty, empty, empty)
ins.run(1, 1, 5200, empty, empty, empty, empty)
ins.run(1, 2, 8800, empty, empty, empty, empty)
raw.close()

const { LibraryDatabase } = await import(
  `file://${join(process.cwd(), 'out-e2e', 'main', 'db.js').replace(/\\/g, '/')}`
)
const db = new LibraryDatabase(dbPath)
const manifest = db.listFrameManifest(1)

let fail = 0
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) fail++
}

check('返回 3 条', manifest.length === 3, `实际 ${manifest.length}`)
check(
  '首条 frameIndex 是数字 0',
  manifest[0]?.frameIndex === 0,
  `实际 ${JSON.stringify(manifest[0])}`
)
check(
  '首条 timeMs 是数字 1500',
  manifest[0]?.timeMs === 1500,
  `实际 ${manifest[0]?.timeMs}`
)
check(
  '不存在的 snake_case 键（防护：未来若有人用 row.frame_index 取值能立即发现）',
  !('frame_index' in (manifest[0] ?? {})) && !('time_ms' in (manifest[0] ?? {})),
  `actual keys: ${Object.keys(manifest[0] ?? {}).join(',')}`
)

db.close()
rmSync(work, { recursive: true, force: true })
console.log(fail ? `\n${fail} 项失败` : '\nlistFrameManifest 驼峰契约：通过')
process.exit(fail ? 1 : 0)
