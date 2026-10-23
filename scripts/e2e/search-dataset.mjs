import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function ffmpegRun(ffmpeg, args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    throw new Error(`FFmpeg 数据集生成失败：${result.error?.message ?? result.stderr ?? result.status}`)
  }
}

// 所有内容由 FFmpeg 内置源生成，参数固定，标准答案随样本一起保存。
export function generateSearchDataset(ffmpeg, runDir) {
  const datasetDir = join(runDir, 'search-dataset')
  const videoDir = join(datasetDir, 'videos')
  const queryDir = join(datasetDir, 'queries')
  mkdirSync(videoDir, { recursive: true })
  mkdirSync(queryDir, { recursive: true })

  const sources = [
    { id: 'bars', source: 'smptehdbars=size=320x180:rate=5' },
    { id: 'rgb', source: 'rgbtestsrc=size=320x180:rate=5' },
    { id: 'motion', source: 'testsrc2=size=320x180:rate=5' }
  ]
  const videos = sources.map(({ id, source }) => {
    const path = join(videoDir, `${id}.mp4`)
    ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', source, '-t', '4', '-c:v', 'mpeg4', '-y', path])
    return { id, path }
  })

  const queries = videos.map(({ id, path }) => {
    const imagePath = join(queryDir, `${id}.png`)
    ffmpegRun(ffmpeg, ['-ss', '1', '-i', path, '-frames:v', '1', '-y', imagePath])
    return { id: `${id}-exact`, imagePath, expectedVideoId: id, expectedTimeSeconds: id === 'motion' ? 1 : null, tier: 'baseline' }
  })

  const jpegPath = join(queryDir, 'motion-compressed.jpg')
  ffmpegRun(ffmpeg, ['-i', join(queryDir, 'motion.png'), '-q:v', '12', '-y', jpegPath])
  queries.push({ id: 'motion-compressed', imagePath: jpegPath, expectedVideoId: 'motion', expectedTimeSeconds: 1, tier: 'stress' })

  const latePath = join(queryDir, 'motion-late.png')
  ffmpegRun(ffmpeg, ['-ss', '3', '-i', join(videoDir, 'motion.mp4'), '-frames:v', '1', '-y', latePath])
  queries.push({ id: 'motion-late', imagePath: latePath, expectedVideoId: 'motion', expectedTimeSeconds: 3, tier: 'stress' })

  const absentPath = join(queryDir, 'absent.png')
  ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', 'color=c=magenta:size=320x180:rate=1', '-frames:v', '1', '-y', absentPath])
  queries.push({ id: 'absent', imagePath: absentPath, expectedVideoId: null, expectedTimeSeconds: null, tier: 'negative' })

  const manifest = { version: 1, videos, queries }
  const manifestPath = join(datasetDir, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  return manifestPath
}
