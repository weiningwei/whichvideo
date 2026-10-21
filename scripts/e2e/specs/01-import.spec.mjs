import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

describe('真实桌面流程：首次导入与搜图', () => {
  it('在真实窗口中导入目录、完成索引并找到对应视频', async () => {
    const videoPath = process.env.WHICHVIDEO_E2E_VIDEO
    const folderPath = process.env.WHICHVIDEO_E2E_FOLDER
    const imagePath = process.env.WHICHVIDEO_E2E_IMAGE
    assert.ok(videoPath && folderPath && imagePath)

    await browser.$('body').waitForExist()
    await browser.waitUntil(async () => browser.tauri.execute(({ core }) => core.invoke('library_media_tools').then((status) => status.ready)), {
      timeout: 30000, timeoutMsg: '真实进程没有找到 ffmpeg/ffprobe'
    })
    const imported = await browser.tauri.execute((tauri, path) => tauri.core.invoke('videos_import_paths', { paths: [path], watchFolders: false }), folderPath)
    assert.equal(imported.added, 1, JSON.stringify(imported))
    assert.equal(imported.failed, 0, JSON.stringify(imported))

    await browser.waitUntil(async () => {
      const page = await browser.tauri.execute(({ core }) => core.invoke('videos_list', { query: { limit: 20, offset: 0 } }))
      return page.items?.length === 1 && page.items[0].status === 'ready' && page.items[0].frameCount > 0
    }, { timeout: 120000, interval: 1000, timeoutMsg: '视频未在 120 秒内完成索引' })

    await browser.$('//nav[@aria-label="主导航"]//button[normalize-space(.)="视频库"]').click()
    await browser.$('//button[normalize-space(.)="全部视频"]').click()
    await browser.$('//*[contains(text(), "sample.mp4")]').waitForDisplayed({ timeout: 10000 })

    const duplicate = await browser.tauri.execute((tauri, path) => tauri.core.invoke('videos_import_paths', { paths: [path], watchFolders: false }), videoPath)
    assert.equal(duplicate.added, 0, JSON.stringify(duplicate))
    assert.equal(duplicate.duplicates, 1, JSON.stringify(duplicate))

    const result = await browser.tauri.execute((tauri, path) => tauri.core.invoke('search_path', { filePath: path }), imagePath)
    assert.ok(result.matches?.length, JSON.stringify(result))
    assert.equal(result.matches[0].video.path.toLowerCase(), videoPath.toLowerCase())

    await browser.$('//nav[@aria-label="主导航"]//button[normalize-space(.)="搜图"]').click()
    const imageBase64 = readFileSync(imagePath).toString('base64')
    await browser.execute((base64) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], 'sample.png', { type: 'image/png' }))
      document.querySelector('main > div')?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }, imageBase64)
    await browser.$('//*[contains(text(), "sample.mp4")]').waitForDisplayed({ timeout: 30000 })
  })
})
