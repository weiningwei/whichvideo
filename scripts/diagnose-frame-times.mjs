/**
 * 诊断：库里帧时间戳是否可信。
 *
 * 对每个视频对比 duration 与帧 timeMs 的分布 —— timeMs 超过 duration 的帧
 * 就是坏数据（全片解码旧逻辑把 ffprobe 偏差的计划时间点硬贴上去造成的）。
 * 只读打开（WAL 并发安全），不动任何数据。
 */
import { createRequire } from 'node:module'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const BetterSqlite3 = require(join(root, 'node_modules', 'better-sqlite3'))

const dbPath = process.argv[2] ?? resolve(root, '..', 'WhichVideo-portable', 'data', 'whichvideo.db')
const db = new BetterSqlite3(dbPath, { readonly: true })

const videos = db
  .prepare('SELECT id, name, duration, frame_count, status FROM videos ORDER BY id')
  .all()

console.log(`库：${dbPath}`)
console.log(`视频数：${videos.length}\n`)
console.log('id | 名称 | 时长(s) | 帧数 | timeMs范围(s) | 超出时长的帧 | 状态')
console.log('-'.repeat(100))

let badVideos = 0
for (const v of videos) {
  const stats = db
    .prepare(
      'SELECT MIN(time_ms) AS minT, MAX(time_ms) AS maxT, COUNT(*) AS n, SUM(CASE WHEN time_ms > ? THEN 1 ELSE 0 END) AS over FROM frames WHERE video_id = ?'
    )
    .get(Math.round((v.duration ?? 0) * 1000), v.id)
  if (stats.n === 0) {
    console.log(`${v.id} | ${v.name} | ${v.duration ?? '?'} | 0 帧 | - | - | ${v.status}`)
    continue
  }
  const over = stats.over ?? 0
  const flag = over > 0 ? ' ←⚠️ 坏数据' : ''
  if (over > 0) badVideos++
  console.log(
    `${v.id} | ${v.name.slice(0, 30)} | ${(v.duration ?? 0).toFixed(0)} | ${v.frame_count}/${stats.n} | ${(
      stats.minT / 1000
    ).toFixed(1)} ~ ${(stats.maxT / 1000).toFixed(1)} | ${over} 帧${flag} | ${v.status}`
  )
}

console.log(`\n结论：${badVideos > 0 ? `${badVideos} 个视频存在超出时长的坏时间戳 —— 必须重建索引才能修` : '未发现超出时长的帧 —— 时间戳数据看起来健康'}`)
db.close()
