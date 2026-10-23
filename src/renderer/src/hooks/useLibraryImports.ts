import { useMemo } from 'react'
import type { ImportResult } from '@shared/types'
import type { UseBusyReturn } from './useBusy'
import type { Notice } from './useNotices'

/** 视频导入与目录监听操作；结果反馈和刷新由调用方注入。 */
export function useLibraryImports(
  withBusy: UseBusyReturn['withBusy'],
  pushNotice: (level: Notice['level'], message: string) => void,
  refreshAll: () => Promise<void>,
  refreshFolders: () => Promise<void>
) {
  return useMemo(() => ({
    async importFiles(): Promise<ImportResult | null> {
      return withBusy('正在导入视频文件…', async () => {
        const result = await window.whichvideo.videos.importFiles()
        pushNotice(
          result.failed ? 'error' : 'info',
          `导入完成：新增 ${result.added}，已存在 ${result.duplicates}，跳过 ${result.skipped}，失败 ${result.failed}${result.scanned === 1 && result.firstError ? `（${result.firstError}）` : ''}`
        )
        await refreshAll()
        return result
      })
    },
    async importDroppedPaths(paths: string[], watchFolders: boolean): Promise<ImportResult | null> {
      if (paths.length === 0) return null
      return withBusy(watchFolders ? '正在添加监视目录…' : '正在导入拖入的内容…', async () => {
        const result = await window.whichvideo.videos.importPaths(paths, watchFolders)
        pushNotice(
          result.failed ? 'error' : 'info',
          `拖入处理完成：目录 ${result.folders}，新增视频 ${result.added}，已存在 ${result.duplicates}，失败 ${result.failed}${result.failed === 1 && result.firstError ? `（${result.firstError}）` : ''}`
        )
        await refreshAll()
        return result
      })
    },
    async importFolderOnce(): Promise<ImportResult | null> {
      return withBusy('正在一次性导入文件夹…', async () => {
        const result = await window.whichvideo.videos.importFolderOnce()
        pushNotice(
          result.failed ? 'error' : 'info',
          `导入完成（未监视）：新增 ${result.added}，已存在 ${result.duplicates}，跳过 ${result.skipped}，失败 ${result.failed}`
        )
        await refreshAll()
        return result
      })
    },
    async watchFolder(): Promise<void> {
      await withBusy('正在扫描文件夹…', async () => {
        const added = await window.whichvideo.folders.addFromDialog()
        pushNotice(
          'info',
          added.length ? `已添加 ${added.length} 个监听文件夹，后台开始建索引` : '未选择文件夹'
        )
        await refreshAll()
      })
    },
    async addFolderPath(dirPath: string): Promise<void> {
      await withBusy('正在扫描文件夹…', async () => {
        await window.whichvideo.folders.addPath(dirPath)
        pushNotice('info', `已添加监听文件夹：${dirPath}`)
        await refreshAll()
      })
    },
    async removeFolder(folderId: number): Promise<void> {
      await withBusy('正在移除监听…', async () => {
        await window.whichvideo.folders.remove(folderId)
        await refreshAll()
      })
    },
    async rescan(folderId?: number): Promise<void> {
      await withBusy('正在重新扫描…', async () => {
        const result = await window.whichvideo.folders.rescan(folderId)
        pushNotice(
          result.failed ? 'error' : 'info',
          `重新扫描完成：新增 ${result.added}，已存在 ${result.duplicates}，跳过 ${result.skipped}，失败 ${result.failed}`
        )
        await refreshAll()
      })
    },
    async toggleFolder(folderId: number, enabled: boolean): Promise<void> {
      await withBusy(enabled ? '正在恢复监听…' : '正在暂停监听…', async () => {
        await window.whichvideo.folders.setEnabled(folderId, enabled)
        await refreshFolders()
      })
    },
  }), [withBusy, pushNotice, refreshAll, refreshFolders])
}