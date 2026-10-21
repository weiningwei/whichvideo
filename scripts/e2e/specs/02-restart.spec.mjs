import assert from 'node:assert/strict'

describe('真实桌面流程：重启恢复', () => {
  it('重新启动后仍能读取视频并搜到对应画面', async () => {
    const videoPath = process.env.WHICHVIDEO_E2E_VIDEO
    const imagePath = process.env.WHICHVIDEO_E2E_IMAGE
    assert.ok(videoPath && imagePath)
    await browser.$('body').waitForExist()
    await browser.waitUntil(async () => {
      const stats = await browser.tauri.execute(({ core }) => core.invoke('library_stats'))
      return stats.videos === 1 && stats.indexedVideos === 1 && stats.frames > 0
    }, { timeout: 60000, interval: 1000, timeoutMsg: '重启后数据库或内存索引未恢复' })
    const result = await browser.tauri.execute((tauri, path) => tauri.core.invoke('search_path', { filePath: path }), imagePath)
    assert.equal(result.matches?.[0]?.video.path.toLowerCase(), videoPath.toLowerCase())
  })
})
