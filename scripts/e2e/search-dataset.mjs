import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function ffmpegRun(ffmpeg, args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    throw new Error(`FFmpeg 数据集生成失败：${result.error?.message ?? result.stderr ?? result.status}`)
  }
}

// 固定源、编码、时间点和变换参数；标签来自生成过程，不依赖搜索结果。
export function generateSearchDataset(ffmpeg, runDir) {
  const datasetDir = join(runDir, 'search-dataset')
  const videoDir = join(datasetDir, 'videos')
  const queryDir = join(datasetDir, 'queries')
  mkdirSync(videoDir, { recursive: true })
  mkdirSync(queryDir, { recursive: true })

  const sources = [
    { id: 'bars', source: 'smptehdbars=size=320x180:rate=5', moving: false },
    { id: 'bars-sd', source: 'smptebars=size=320x180:rate=5,drawbox=x=120:y=40:w=35:h=35:color=white:t=fill', moving: false },
    { id: 'bars-pal', source: 'pal75bars=size=320x180:rate=5', moving: false },
    { id: 'rgb', source: 'rgbtestsrc=size=320x180:rate=5', moving: false },
    { id: 'motion', source: 'testsrc2=size=320x180:rate=5', moving: true },
    { id: 'classic', source: 'testsrc=size=320x180:rate=5', moving: true },
    { id: 'fractal', source: 'mandelbrot=size=320x180:rate=5', moving: true },
    { id: 'chart', source: 'colorchart=rate=5:patch_size=64x48', moving: false }
  ]
  const videos = sources.map(({ id, source }) => {
    const path = join(videoDir, `${id}.mp4`)
    ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', source, '-t', '4', '-c:v', 'mpeg4', '-y', path])
    return { id, path }
  })

  const queries = []
  function addQuery(id, imagePath, expectedVideoId, expectedTimeSeconds, variant, tier = 'stress') {
    queries.push({ id, imagePath, expectedVideoId, expectedTimeSeconds, variant, tier })
  }
  function extract(id, videoId, timeSeconds) {
    const imagePath = join(queryDir, `${id}.png`)
    ffmpegRun(ffmpeg, ['-ss', String(timeSeconds), '-i', join(videoDir, `${videoId}.mp4`), '-frames:v', '1', '-y', imagePath])
    return imagePath
  }
  function transform(id, sourcePath, filter, extension = 'png', extra = []) {
    const imagePath = join(queryDir, `${id}.${extension}`)
    ffmpegRun(ffmpeg, ['-i', sourcePath, '-vf', filter, '-frames:v', '1', ...extra, '-y', imagePath])
    return imagePath
  }

  for (const { id, moving } of sources) {
    const path = extract(`${id}-exact`, id, 1)
    addQuery(`${id}-exact`, path, id, moving ? 1 : null, 'exact', 'baseline')
  }

  for (const [videoId, timeSeconds] of [['motion', 0.4], ['motion', 3], ['classic', 2.4], ['fractal', 3]]) {
    const id = `${videoId}-at-${String(timeSeconds).replace('.', '-')}`
    addQuery(id, extract(id, videoId, timeSeconds), videoId, timeSeconds, 'time')
  }

  for (const [index, { id: videoId, moving }] of sources.entries()) {
    const base = join(queryDir, `${videoId}-exact.png`)
    const expectedTime = moving ? 1 : null
    const quality = index % 2 === 0 ? 12 : 20
    const size = index % 2 === 0 ? '160:90' : '640:360'
    const variants = [
      { kind: 'jpeg', filter: 'null', extension: 'jpg', extra: ['-q:v', String(quality)] },
      { kind: 'resize', filter: `scale=${size}` },
      { kind: 'crop', filter: 'crop=256:144:32:18' },
      { kind: 'letterbox', filter: 'pad=iw+80:ih+60:40:30:black' },
      { kind: 'grayscale', filter: 'format=gray' },
      { kind: 'blur', filter: 'gblur=sigma=1.5' }
    ]
    for (const { kind, filter, extension, extra } of variants) {
      const id = `${videoId}-${kind}`
      addQuery(id, transform(id, base, filter, extension, extra), videoId, expectedTime, kind)
    }
  }

  for (const [id, color] of [['absent-magenta', 'magenta'], ['absent-cyan', 'cyan']]) {
    const imagePath = join(queryDir, `${id}.png`)
    ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', `color=c=${color}:size=320x180:rate=1`, '-frames:v', '1', '-y', imagePath])
    addQuery(id, imagePath, null, null, 'negative', 'negative')
  }
  const patternPath = join(queryDir, 'absent-pattern.png')
  ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', 'cellauto=rule=30:size=320x180:rate=1:seed=42:start_full=1', '-frames:v', '1', '-y', patternPath])
  addQuery('absent-pattern', patternPath, null, null, 'negative', 'negative')

  const manifest = { version: 3, videos, queries }
  const manifestPath = join(datasetDir, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  return manifestPath
}
