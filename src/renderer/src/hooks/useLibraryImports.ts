import { useMemo, useState } from 'react'
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
  const [lastImportResult, setLastImportResult] = useState<ImportResult | null>(null)
  const operations = useMemo(() => ({
    async importFiles(): Promise<ImportResult | null> {
      return withBusy('正在导入视频文件…', async () => {
        const result = await window.whichvideo.videos.importFiles()
        if (result.scanned || result.failed) setLastImportResult(result)
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
        setLastImportResult(result)
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
        if (result.scanned || result.failed) setLastImportResult(result)
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
        setLastImportResult(result)
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
    async retryImportFailures(): Promise<void> {
      if (!lastImportResult?.failures.length) return
      await withBusy('正在重试导入失败项…', async () => {
        const folderIds = [...new Set(lastImportResult.failures.flatMap((failure) => failure.folderId == null ? [] : [failure.folderId]))]
        const paths = [...new Set(lastImportResult.failures.filter((failure) => failure.folderId == null).map((failure) => failure.path))]
        const results: ImportResult[] = []
        for (const id of folderIds) results.push(await window.whichvideo.folders.rescan(id))
        if (paths.length) results.push(await window.whichvideo.videos.importPaths(paths, false))
        const result = results.reduce<ImportResult>((total, part) => ({
          added: total.added + part.added,
          duplicates: total.duplicates + part.duplicates,
          skipped: total.skipped + part.skipped,
          failed: total.failed + part.failed,
          scanned: total.scanned + part.scanned,
          folders: total.folders + part.folders,
          firstError: total.firstError ?? part.firstError,
          failures: [...total.failures, ...part.failures],
        }), { added: 0, duplicates: 0, skipped: 0, failed: 0, scanned: 0, folders: 0, failures: [] })
        setLastImportResult(result)
        pushNotice(result.failed ? 'error' : 'info', `重试完成：新增 ${result.added}，失败 ${result.failed}`)
        await refreshAll()
      })
    },
  }), [withBusy, pushNotice, refreshAll, refreshFolders, lastImportResult])
  return useMemo(() => ({ ...operations, lastImportResult }), [operations, lastImportResult])
}
