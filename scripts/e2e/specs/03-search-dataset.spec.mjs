import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const normalizePath = (path) => process.platform === 'win32' ? path.replaceAll('/', '\\').toLowerCase() : path

describe('真实桌面流程：带标准答案的搜索数据集', () => {
  it('评估多视频的命中、排序、时间误差和库外查询', async function () {
    const manifestPath = process.env.WHICHVIDEO_E2E_DATASET_MANIFEST
    assert.ok(manifestPath)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    this.timeout(manifest.profile === 'extended' ? 900000 : 300000)
    const videoPaths = new Map(manifest.videos.map((video) => [video.id, video.path]))

    await browser.$('body').waitForExist()
    const imported = await browser.tauri.execute((tauri, path) => tauri.core.invoke('videos_import_paths', {
      paths: [path], watchFolders: false
    }), join(dirname(manifestPath), 'videos'))
    assert.equal(imported.added, manifest.videos.length, JSON.stringify(imported))
    assert.equal(imported.failed, 0, JSON.stringify(imported))

    await browser.waitUntil(async () => {
      const stats = await browser.tauri.execute(({ core }) => core.invoke('library_stats'))
      return stats.indexedVideos === manifest.videos.length + 1
    }, { timeout: 120000, interval: 1000, timeoutMsg: '数据集视频未在 120 秒内完成索引' })

    const rows = []
    for (const query of manifest.queries) {
      const result = await browser.tauri.execute((tauri, path) => tauri.core.invoke('search_path', { filePath: path }), query.imagePath)
      assert.equal(result.error, undefined, `${query.id}: ${JSON.stringify(result)}`)
      const expectedPath = videoPaths.get(query.expectedVideoId)
      const rank = expectedPath ? result.matches.findIndex((match) => normalizePath(match.video.path) === normalizePath(expectedPath)) + 1 : null
      const hit = rank ? result.matches[rank - 1] : null
      rows.push({
        id: query.id,
        tier: query.tier,
        variant: query.variant,
        expectedVideoId: query.expectedVideoId,
        expectedTimeSeconds: query.expectedTimeSeconds,
        rank,
        top1: rank === 1,
        hitTimeSeconds: hit?.timeSeconds ?? null,
        timeErrorSeconds: hit && query.expectedTimeSeconds !== null
          ? Math.abs(hit.timeSeconds - query.expectedTimeSeconds) : null,
        elapsedMs: result.elapsedMs,
        matches: result.matches.slice(0, 5).map((match) => ({
          video: match.video.path,
          score: match.score,
          timeSeconds: match.timeSeconds
        }))
      })
    }

    const positives = rows.filter((row) => row.expectedVideoId !== null)
    const baseline = positives.filter((row) => row.tier === 'baseline')
    const timed = positives.filter((row) => row.timeErrorSeconds !== null)
    const byVariant = Object.fromEntries([...new Set(rows.map((row) => row.variant))].map((variant) => {
      const group = positives.filter((row) => row.variant === variant)
      return [variant, {
        count: rows.filter((row) => row.variant === variant).length,
        top1: group.length ? `${group.filter((row) => row.top1).length}/${group.length}` : null,
        top5: group.length ? `${group.filter((row) => row.rank > 0 && row.rank <= 5).length}/${group.length}` : null
      }]
    }))
    const report = {
      manifestPath,
      datasetVersion: manifest.version,
      profile: manifest.profile,
      summary: {
        baselineTop1: `${baseline.filter((row) => row.top1).length}/${baseline.length}`,
        positiveTop1: `${positives.filter((row) => row.top1).length}/${positives.length}`,
        positiveTop5: `${positives.filter((row) => row.rank > 0 && row.rank <= 5).length}/${positives.length}`,
        missedPositiveQueries: positives.filter((row) => !row.top1).map((row) => row.id),
        negativeWithMatches: rows.filter((row) => row.tier === 'negative' && row.matches.length > 0).length,
        labeledWithinHalfSecond: `${timed.filter((row) => row.timeErrorSeconds <= 0.5).length}/${timed.length}`,
        worstLabeledTimeError: timed.length
          ? timed.reduce((worst, row) => row.timeErrorSeconds > worst.timeErrorSeconds ? row : worst, timed[0]).id : null,
        maxLabeledTimeErrorSeconds: timed.length ? Math.max(...timed.map((row) => row.timeErrorSeconds)) : null,
        meanLabeledTimeErrorSeconds: timed.length
          ? timed.reduce((sum, row) => sum + row.timeErrorSeconds, 0) / timed.length : null
      },
      byVariant,
      rows
    }
    const reportPath = join(dirname(manifestPath), 'report.json')
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(`搜索数据集评测：${JSON.stringify(report.summary)}；完整结果：${reportPath}`)

    assert.equal(baseline.filter((row) => row.top1).length, baseline.length, '基础查询必须全部命中正确视频的首位')
  })
})
