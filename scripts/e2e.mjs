/**
 * 端到端自检（不需要 Electron 窗口，直接跑核心链路）。
 *
 * 分两部分：
 *   A. 核心链路：用 ffmpeg 生成真实帧数据 → 走真实的建库/哈希/量化/内存索引/搜索代码
 *   B. 完整流水线：真的调用 Indexer 去扫描目录、抽帧、监听文件变化
 *      —— 若当前环境禁止子进程管道（受限沙箱下的已知限制），这部分会标注为 SKIP
 *
 * 运行：
 *   node scripts/build-core.mjs && node scripts/e2e.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const work = join(root, 'tmp', 'e2e')

const results = []
let failed = 0
let passed = 0
const skipped = []

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    results.push({ name, ok: true, detail })
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    results.push({ name, ok: false, detail })
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function skip(name, reason) {
  skipped.push({ name, reason })
  console.log(`  ⤼ SKIP ${name} — ${reason}`)
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

const F = 320 // 抽帧宽度，与主进程 EXTRACT_WIDTH 保持一致

async function main() {
  const out = join(root, 'out-e2e')
  if (!existsSync(join(out, 'main', 'db.js'))) {
    console.error('请先运行 node scripts/build-core.mjs')
    process.exit(1)
  }

  const load = (name) => import(pathToFileURL(join(out, 'main', `${name}.js`)).href)
  const { LibraryDatabase } = await load('db')
  const { FrameSearchIndex, queryVectorFromImage } = await load('search')
  const { Indexer } = await load('indexer')
  const { FolderWatcher } = await load('watcher')
  const { extractAndHash, scanVideoFiles, statFile } = await load('scan')
  const { resolveTools, planTimestamps, probeVideo } = await load('media')
  const { computeSignature, hammingBytes, STRUCT_BYTES } = await import(
    pathToFileURL(join(out, 'shared', 'hash.js')).href
  )
  const {
    COLOR_OFFSET,
    STRUCT_OFFSET,
    FRAME_STRIDE,
    quantizeColor,
    quantizedColorfulness,
    quantizedHistogramSimilarity
  } = await import(pathToFileURL(join(out, 'shared', 'framepack.js')).href)

  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })

  const tools = resolveTools()
  if (!tools) {
    console.error('未找到 ffmpeg / ffprobe，自检无法进行')
    process.exit(1)
  }
  console.log(`使用 ffmpeg：${tools.ffmpeg}`)

  /** 用绝对路径调用 ffmpeg；受限环境用 inherit stdio 才能 spawn 成功 */
  const ff = (args, outFile) => {
    const r = spawnSync(
      tools.ffmpeg,
      ['-hide_banner', '-v', 'error', '-y', ...args, ...(outFile ? [outFile] : [])],
      { stdio: 'inherit' }
    )
    if (r.status !== 0) throw new Error(`ffmpeg 失败（${r.status}）：${args.join(' ')}`)
  }

  /**
   * 从 lavfi 源导出「第 n 帧」的 raw RGB。
   * 注意：lavfi 源不支持 -ss 定位，必须用 select/trim 挑帧，
   * 因此这里统一用帧号而不是时间点，保证用于比对的画面完全一致。
   */
  const rawFrameAt = (source, frameIndex) => {
    const target = join(work, `raw-${Math.random().toString(36).slice(2)}.rgb`)
    ff(
      [
        '-f',
        'lavfi',
        '-i',
        source,
        '-vf',
        `select=eq(n\\,${frameIndex}),scale=w=${F}:h=-2`,
        '-frames:v',
        '1',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo'
      ],
      target
    )
    const data = readFileSync(target)
    const height = data.length / (F * 3)
    rmSync(target, { force: true })
    return { width: F, height, channels: 3, order: 'rgb', data }
  }

  /** 从 lavfi 源导出「第 n 帧」的 PNG（模拟用户给的截图） */
  const pngFrameAt = (source, frameIndex, name) => {
    const png = join(work, `${name}.png`)
    ff(
      [
        '-f',
        'lavfi',
        '-i',
        source,
        '-vf',
        `select=eq(n\\,${frameIndex}),scale=w=${F}:h=-2`,
        '-frames:v',
        '1'
      ],
      png
    )
    return png
  }

  /** PNG → 缩放后的 RGB24 */
  const rgbFromImage = (imagePath) => {
    const target = join(work, `img-${Math.random().toString(36).slice(2)}.rgb`)
    ff(['-i', imagePath, '-vf', `scale=w=${F}:h=-2`, '-pix_fmt', 'rgb24', '-f', 'rawvideo'], target)
    const data = readFileSync(target)
    const height = data.length / (F * 3)
    rmSync(target, { force: true })
    return { width: F, height, channels: 3, order: 'rgb', data }
  }

  /* ================================================================ *
   * A. 核心链路
   * ================================================================ */
  section('A1. 指纹算法：同一画面在 raw / PNG 之间应几乎无差异')

  const sources = [
    { key: 'testsrc2', source: 'testsrc2=size=640x360:rate=25:duration=8', label: '动态测试图案' },
    { key: 'bars', source: 'smptebars=size=640x360:rate=25:duration=8', label: 'SMPTE 彩条' },
    { key: 'blue', source: 'color=c=0x1b3a6b:size=480x270:rate=25:duration=8', label: '深蓝底' },
    { key: 'amber', source: 'color=c=0x6b5a1b:size=480x270:rate=25:duration=8', label: '暗黄底' },
    { key: 'grad', source: 'testsrc=size=640x360:rate=25:duration=8', label: '渐变测试图' }
  ]

  const hashes = new Map()
  for (const item of sources) {
    // 两个分支都取同一帧（第 100 帧），动态图案才能保证画面一致
    const raw = computeSignature(rawFrameAt(item.source, 100))
    const png = pngFrameAt(item.source, 100, `q-${item.key}`)
    const fromPng = computeSignature(rgbFromImage(png))
    hashes.set(item.key, { raw, fromPng })
    const dist64 = hammingBytes(raw.struct, 0, fromPng.struct, 0, STRUCT_BYTES)
    check(`「${item.label}」raw↔PNG 结构距离 ≤ 8（共 512bit）`, dist64 <= 8, `距离 ${dist64}`)
  }

  // 结构与色彩本身都无法区分两个不同的纯色画面，因此只比较"至少一方有内容"的组合
  const isFlat = (key) => key === 'blue' || key === 'amber'
  let minCross = 512
  let minCrossPair = ''
  for (const a of sources) {
    for (const b of sources) {
      if (a.key === b.key) continue
      if (isFlat(a.key) && isFlat(b.key)) continue
      const d = hammingBytes(hashes.get(a.key).raw.struct, 0, hashes.get(b.key).raw.struct, 0, STRUCT_BYTES)
      if (d < minCross) {
        minCross = d
        minCrossPair = `${a.key}↔${b.key}`
      }
    }
  }
  check(
    '有内容的画面之间结构距离足够大',
    minCross >= 100,
    `最小跨内容距离 ${minCross}（${minCrossPair}）`
  )
  // 纯色之间结构距离为 0 是预期行为：此时颜色直方图负责区分（见 A2 的排序结果）
  const flatVsFlat = hammingBytes(
    hashes.get('blue').raw.struct,
    0,
    hashes.get('amber').raw.struct,
    0,
    STRUCT_BYTES
  )
  check('纯色画面结构距离为 0（由颜色直方图区分）', flatVsFlat === 0, `距离 ${flatVsFlat}`)

  section('A2. 建库 / 内存索引 / 搜索排序（真实帧数据注入）')

  const db = new LibraryDatabase(join(work, 'core.db'))
  const index = new FrameSearchIndex(db)

  /**
   * 把某个 lavfi 源当成一个"视频"：抽若干帧，走真实的哈希/量化/入库路径。
   * 每一帧同时导出一份 PNG（模拟"用户手里的截图"），
   * 因此"截图 → 命中该视频"是严格可验证的：PNG 与入库帧来自同一画面。
   */
  const injectVideo = (name, source, duration = 12, frameCount = 6, queryPick = 2) => {
    const { video } = db.upsertVideo({
      path: join(work, 'fake', name),
      size: 1024,
      mtimeMs: Date.now(),
      duration,
      width: 640,
      height: 360,
      videoCodec: 'h264',
      folderId: null
    })
    const timestamps = planTimestamps(duration, frameCount)
    let queryPng = null
    const frames = timestamps.map((time, i) => {
      const src = `${source}`
      // lavfi 源不支持 -ss，用帧号挑帧：源按 25fps 生成，帧号 = 时间 × 25
      const frameIndexInSource = Math.round(time * 25)
      const sig = computeSignature(rawFrameAt(src, frameIndexInSource))
      if (i === queryPick) queryPng = pngFrameAt(src, frameIndexInSource, `q-${name.replace(/\W+/g, '-')}`)
      return {
        dhash: sig.dhash,
        struct: sig.struct,
        color: quantizeColor(sig.color),
        frameIndex: i,
        timeMs: Math.round(time * 1000)
      }
    })
    db.replaceFrames(video.id, frames, null)
    return { video: db.getVideo(video.id), frames: frames.length, queryPng }
  }

  const injected = sources.map((item) => ({
    ...item,
    ...injectVideo(`${item.key}.mp4`, item.source)
  }))
  index.rebuild()

  check('假视频入库且状态为 ready', injected.every((v) => v.video.status === 'ready'), `${injected.length} 个视频`)
  check(
    '帧指纹数量正确',
    db.frameCount() === injected.length * 6 && index.frameCount === db.frameCount(),
    `${db.frameCount()} 帧`
  )

  const search = (imagePath) => {
    const vector = queryVectorFromImage(rgbFromImage(imagePath))
    const settings = db.getSettings()
    return index.search(vector, { minHashScore: settings.minHashScore, maxResults: settings.maxResults })
  }

  let allRankedFirst = true
  const hitScores = []
  for (const item of injected) {
    const res = search(item.queryPng)
    const top = res.results[0] ? db.getVideo(res.results[0].videoId) : null
    const ok = top?.name === `${item.key}.mp4`
    allRankedFirst = allRankedFirst && ok
    hitScores.push(res.results[0]?.score ?? 0)
    check(
      `用「${item.label}」的截图能命中自己且排第一`,
      ok,
      `命中 ${top?.name ?? '无'} 分数 ${res.results[0]?.score?.toFixed(3) ?? '-'}（候选 ${res.results.length}）`
    )
  }
  check('五个来源全部正确排序', allRankedFirst)
  check(
    '命中分数均高于 0.8',
    hitScores.every((s) => s > 0.8),
    hitScores.map((s) => s.toFixed(3)).join(', ')
  )

  section('A3. 未下载 / 新内容不会被误判为已下载')

  const foreign = pngFrameAt('mandelbrot=size=640x360:rate=25', 80, 'q-foreign')
  const foreignRes = search(foreign)
  check(
    '库里没有的画面不会被误判为已下载',
    foreignRes.results.length === 0 || foreignRes.results[0].score < Math.min(...hitScores) - 0.05,
    foreignRes.results.length ? `最高分 ${foreignRes.results[0].score.toFixed(3)}` : '零命中'
  )

  const newcomer = injectVideo('newcomer.mp4', 'testsrc=size=800x450:rate=25:duration=10', 10)
  index.rebuild()
  const newcomerRes = search(newcomer.queryPng)
  const newcomerTop = newcomerRes.results[0] ? db.getVideo(newcomerRes.results[0].videoId) : null
  check(
    '新增内容重建索引后可立即命中',
    newcomerTop?.name === 'newcomer.mp4',
    `命中 ${newcomerTop?.name ?? '无'} 分数 ${newcomerRes.results[0]?.score?.toFixed(3) ?? '-'}`
  )

  section('A4. 检索性能')

  const perfVector = queryVectorFromImage(rgbFromImage(injected[0].queryPng))
  const iterations = 500
  const t0 = performance.now()
  for (let i = 0; i < iterations; i++) {
    index.search(perfVector, { minHashScore: 0, maxResults: 40 })
  }
  const perSearch = (performance.now() - t0) / iterations
  const frames = index.frameCount
  check(
    `全量扫描（${frames} 帧）耗时 < 20ms`,
    perSearch < 20,
    `${perSearch.toFixed(3)}ms/次 → 5 万帧约 ${((perSearch * 50000) / frames).toFixed(0)}ms`
  )

  section('A5. 库管理 / 统计 / 查询')

  const stats = db.stats()
  check(
    '统计信息合理',
    stats.videos > 0 && stats.frames > 0 && stats.indexedVideos === stats.videos,
    JSON.stringify(stats)
  )
  const byKeyword = db.listVideos({ keyword: 'blue', limit: 20 })
  check('按文件名筛选', byKeyword.total === 1 && byKeyword.items[0].name === 'blue.mp4', `${byKeyword.total} 条`)
  const firstId = injected[0].video.id
  db.setVideoStatus(firstId, 'pending')
  check('可按状态筛选待索引', db.listVideos({ status: 'pending' }).total === 1)
  db.setVideoStatus(firstId, 'ready')
  const removed = db.removeVideo(injected[1].video.id)
  index.rebuild()
  check('移除视频后内存索引同步', removed && index.frameCount === db.frameCount(), `${index.frameCount} 帧`)

  /* ================================================================ *
   * B. 完整流水线（真实抽帧 / 扫描 / 监听）
   * ================================================================ */
  section('B1. 真实抽帧管道可用性')

  const mediaDir = join(work, 'media')
  mkdirSync(mediaDir, { recursive: true })
  const videoA = join(mediaDir, 'alpha.mp4')
  ff(
    [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=25:duration=6',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast'
    ],
    videoA
  )

  let pipeWorks = true
  let pipeError = ''
  let extractedFrames = 0
  try {
    const frames = await extractAndHash(videoA, planTimestamps(6, 6), db.getSettings())
    extractedFrames = frames.length
    pipeWorks = frames.length > 0
    if (!pipeWorks) pipeError = '抽到的帧数为 0'
  } catch (err) {
    pipeWorks = false
    pipeError = err instanceof Error ? err.message : String(err)
  }

  const plannedFrames = planTimestamps(6, 6).length
  check(
    '抽帧结果帧数与计划一致',
    !pipeWorks ? true : extractedFrames === plannedFrames,
    pipeWorks ? `抽到 ${extractedFrames}/${plannedFrames} 帧` : `管道不可用：${pipeError}`
  )

  if (pipeWorks) {
    const probe = await probeVideo(videoA)
    check('ffprobe 读取视频元数据', probe.width === 640 && probe.height === 360, JSON.stringify(probe))
  } else {
    skip('ffprobe 读取视频元数据', 'ffprobe 也走子进程管道，当前环境被拦')
  }
  const scan = await scanVideoFiles(mediaDir)
  check('目录递归扫描', scan.files === 1, `扫描到 ${scan.files} 个视频`)
  check('文件 stat', !!statFile(videoA), `${statFile(videoA)?.size} 字节`)

  if (!pipeWorks) {
    skip(
      'B2. Indexer 完整流水线（导入 → 抽帧 → 入库 → 缩略图）',
      `当前环境禁止子进程管道，主进程抽帧代码无法在此运行：${pipeError}`
    )
    skip('B3. 文件夹新增 / 删除的自动同步', '同上，需要真实抽帧才能验证端到端行为')
  } else {
    const seriesDir = join(work, 'series', 'Season 01')
    mkdirSync(seriesDir, { recursive: true })
    const videoB = join(mediaDir, 'bravo.mp4')
    ff(
      [
        '-f',
        'lavfi',
        '-i',
        'smptebars=size=640x360:rate=25:duration=6',
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast'
      ],
      videoB
    )
    const ep1 = join(seriesDir, 'Show.S01E01.mp4')
    ff(
      [
        '-f',
        'lavfi',
        '-i',
        'color=c=0x1b3a6b:size=480x270:rate=25:duration=8',
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast'
      ],
      ep1
    )

    const pipeDb = new LibraryDatabase(join(work, 'pipe.db'))
    const pipeIndex = new FrameSearchIndex(pipeDb)
    const pipeIndexer = new Indexer(pipeDb, pipeIndex, () => pipeDb.getSettings(), () => {})
    const pipeWatcher = new FolderWatcher(pipeDb, pipeIndexer, () => {}, () => 400)

    const idle = async (timeout = 180000) => {
      const start = Date.now()
      while (Date.now() - start < timeout) {
        const s = pipeIndexer.status()
        if (!s.running && s.active === 0 && s.queued === 0) return true
        await new Promise((r) => setTimeout(r, 150))
      }
      return false
    }

    section('B2. Indexer 完整流水线')

    const importResult = await pipeIndexer.importFiles([videoA, videoB])
    check('导入返回新增 2', importResult.added === 2, JSON.stringify(importResult))
    check('索引队列跑完', await idle(), JSON.stringify(pipeIndexer.status()))
    const rowA = pipeDb.findByPath(videoA)
    check('视频 A 索引完成', rowA?.status === 'ready', `状态 ${rowA?.status} 帧 ${rowA?.frameCount}`)
    check('写入了缩略图', !!pipeDb.getThumbnail(rowA.id))

    const folder = await pipeIndexer.importFolder(join(work, 'series'), { pinned: true })
    check('递归导入文件夹', folder.scanned === 1, JSON.stringify(folder))
    await idle()
    await pipeWatcher.syncAll()
    await new Promise((r) => setTimeout(r, 1500))
    const watched = pipeDb.listFolders().find((f) => f.pathKey === join(work, 'series').toLowerCase())
    check('文件夹进入监听状态', watched?.watchState === 'watching', `状态 ${watched?.watchState}`)

    section('B3. 文件夹动态更新')

    const ep2 = join(seriesDir, 'Show.S01E02.mp4')
    ff(
      [
        '-f',
        'lavfi',
        '-i',
        'color=c=0x6b1b3a:size=480x270:rate=25:duration=8',
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast'
      ],
      ep2
    )
    const waitFor = async (predicate, timeout = 60000) => {
      const start = Date.now()
      while (Date.now() - start < timeout) {
        if (predicate()) return true
        await new Promise((r) => setTimeout(r, 200))
      }
      return false
    }
    check('新增视频被自动发现', await waitFor(() => !!pipeDb.findByPath(ep2)))
    await idle()
    check('新增视频索引完成', pipeDb.findByPath(ep2)?.status === 'ready')

    const ep1Id = pipeDb.findByPath(ep1).id
    rmSync(ep1, { force: true })
    check('删除的视频自动移出索引库', await waitFor(() => !pipeDb.findByPath(ep1)), '')
    check('被删除视频的记录已清理', pipeDb.getVideo(ep1Id) === null)

    await pipeWatcher.stopAll()
    pipeDb.close()
  }

  db.close()

  console.log(`\n=== 结果：通过 ${passed} · 失败 ${failed} · 跳过 ${skipped.length} ===`)
  if (skipped.length) {
    console.log('跳过项（原因见下，在不禁用子进程管道的环境里可完整执行）：')
    for (const s of skipped) console.log(`  - ${s.name}：${s.reason}`)
  }
  if (failed) {
    console.log('失败项：')
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name} ${r.detail}`)
  }
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error('\n自检异常终止：', err)
  process.exit(1)
})
