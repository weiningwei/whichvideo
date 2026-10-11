/**
 * 诊断工具：把库内每个视频的索引帧 timeMs 全部 dump 出来，
 * 用来核对"场景采样抽到的时间点是不是预期位置"。
 *
 * 用法：
 *   1. 先在应用里点"打开数据目录"按钮（库里代码：IPC.libraryOpenDb，
 *      对应 shell.openPath 数据库所在目录），拿到数据目录绝对路径。
 *   2. node scripts/dump-frame-times.mjs <数据目录>
 *
 * 输出每个视频一行 `path | frame_count | sampling | times...`，
 * timeMs 升序列出；视频总多再加 -v 才显示。
 *
 * 例：
 *   $ node scripts/dump-frame-times.mjs D:\Apps\WhichVideo\data
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const dir = process.argv[2]
if (!dir || !existsSync(dir)) {
  console.error('用法：node scripts/dump-frame-times.mjs <数据目录>')
  console.error('找不到目录：', dir)
  process.exit(1)
}
const dbPath = join(dir, 'whichvideo.db')
if (!existsSync(dbPath)) {
  console.error('数据目录里没有 whichvideo.db：', dbPath)
  process.exit(1)
}

const verbose = process.argv.includes('-v')

const db = new Database(dbPath, { readonly: true })

const videos = db
  .prepare(
    `SELECT id, name, duration, frame_count, sampling_override
     FROM videos
     WHERE frame_count > 0
     ORDER BY id`
  )
  .all()

if (videos.length === 0) {
  console.log('库里没有任何视频（或都还没索引完成）。')
  process.exit(0)
}

let totalFrames = 0
for (const v of videos) {
  const rows = db
    .prepare('SELECT frame_index, time_ms FROM frames WHERE video_id = ? ORDER BY frame_index')
    .all(v.id)
  totalFrames += rows.length
  const sampling = v.sampling_override ?? 'inherit'
  const samplingLabel = sampling === 'inherit' ? 'inherit' : sampling
  const durationS = v.duration ? `${v.duration.toFixed(1)}s` : '?'
  // 时间点转 mm:ss（更易看）
  const fmt = (ms) => {
    const sec = ms / 1000
    const m = Math.floor(sec / 60)
    const s = (sec - m * 60).toFixed(2).padStart(5, '0')
    return `${m}:${s}`
  }
  const times = rows.map((r) => fmt(r.time_ms))
  if (verbose) {
    console.log(`\n[${v.id}] ${v.name}`)
    console.log(`  时长 ${durationS}  帧数 ${rows.length}  采样 ${samplingLabel}`)
    console.log(`  times: ${times.join('  ')}`)
  } else {
    // 紧凑模式：单行打完
    console.log(
      `[${String(v.id).padStart(4)}] ${samplingLabel.padEnd(7)} ${rows.length}f ${durationS.padStart(7)}  ${v.name}`
    )
    console.log(`       ${times.join('  ')}`)
  }
}

console.log(
  `\n合计：${videos.length} 个视频 · ${totalFrames} 帧  ` +
    `（紧凑模式只看单行；加 -v 看完整信息）`
)

db.close()
