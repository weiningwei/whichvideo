import { useEffect, useState } from 'react'
import type { DuplicatePair, IndexerStatus, SamplingMode, VideoQuery, VideoRecord } from '@shared/types'
import type { ImportProgressEvent } from '../lib/importProgress'
import { reverseVideoSort, sortVideoQuery } from '../lib/videoSort'
import { useConfirm } from './ConfirmDialog'
import { PopoverItem, PopoverMenu, usePopoverDismiss } from './PopoverMenu'
import { useAsyncAction } from '../hooks/useAsyncAction'

interface ToolbarProps {
  busy: string | null
  importProgress: ImportProgressEvent | null
  indexStatus: IndexerStatus | null
  query: VideoQuery
  onSetQuery: (query: VideoQuery) => void
  videos: VideoRecord[]
  total: number
  selectedVideoIds: Set<number>
  onSelectAll: () => void
  treeVisible: boolean
  onToggleTree: () => void
  onImportFiles: () => void
  onImportFolder: () => void
  onWatchFolder: () => void
  onManageFolders: () => void
  onOpenSettings: () => void
  onFindDuplicates: (minScore?: number) => Promise<DuplicatePair[] | null>
  onDuplicatesResolved: (pairs: DuplicatePair[]) => void
  onReindex: (videoIds?: number[], mode?: SamplingMode) => void
  onRescan: (folderId?: number) => void
  onRemoveVideos: (videoIds: number[]) => Promise<number[]>
  clearSelection: () => void
  filterInputRef: React.RefObject<HTMLInputElement | null>
}

export function Toolbar(props: ToolbarProps) {
  const confirm = useConfirm()
  const {
    busy, importProgress, indexStatus,
    query, onSetQuery, videos, total, selectedVideoIds, onSelectAll, treeVisible, onToggleTree,
    onImportFiles, onImportFolder, onWatchFolder, onManageFolders, onOpenSettings,
    onFindDuplicates, onDuplicatesResolved, onReindex, onRescan, onRemoveVideos,
    clearSelection, filterInputRef
  } = props
  const [addOpen, setAddOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const duplicateScan = useAsyncAction()
  const videoRemoval = useAsyncAction()
  const importing = Boolean(importProgress || busy?.includes('导入') || busy?.includes('扫描') || busy?.includes('监视目录'))
  const processing = Boolean(busy || importProgress)
  const indexing = Boolean(indexStatus?.running)
  const progressLabel = importProgress
    ? importProgress.total > 0
      ? `导入 ${importProgress.processed}/${importProgress.total} · 新增 ${importProgress.added}`
      : `正在遍历文件 · 已发现 ${importProgress.processed}`
    : busy ?? (indexing ? `索引 ${indexStatus?.done ?? 0}/${indexStatus?.total ?? 0}` : null)
  useEffect(() => { setAddOpen(false); setMoreOpen(false) }, [selectedVideoIds])
  const closeMenus = () => { setAddOpen(false); setMoreOpen(false) }
  usePopoverDismiss(addOpen || moreOpen, '[data-toolbar-menu]', closeMenus)

  const runDuplicateScan = () => {
    setMoreOpen(false)
    void duplicateScan.run(async () => {
      const pairs = await onFindDuplicates()
      if (pairs !== null) onDuplicatesResolved(pairs)
    })
  }

  return (
    <div className="shrink-0 border-b border-line bg-surface-1">
      <div className="flex h-14 items-center gap-3 px-4">
        <div>
          <h1 className="text-[15px] font-semibold text-primary">视频库</h1>
          <div className="text-[10.5px] tabular-nums text-tertiary">{total} 个视频</div>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          {progressLabel && <span role="status" className="max-w-48 truncate text-[11px] tabular-nums text-accent" title={progressLabel}>{progressLabel}</span>}
          <div className="relative" data-toolbar-menu>
            <button
              className="btn border-accent-strong bg-accent px-3.5 text-surface-0 hover:opacity-90"
              disabled={processing}
              onClick={() => { setAddOpen((v) => !v); setMoreOpen(false) }}
              aria-expanded={addOpen}
            >
              {importing ? '添加中…' : '＋ 添加'}
            </button>
            {addOpen && (
              <PopoverMenu className="absolute right-0 top-full z-40 mt-2 w-56">
                <PopoverItem label="视频文件" hint="可切换所有文件，由 FFmpeg 验证" onClick={() => { setAddOpen(false); onImportFiles() }} />
                <PopoverItem label="导入文件夹" hint="扫描一次，不持续监视" onClick={() => { setAddOpen(false); onImportFolder() }} />
                <PopoverItem label="监视文件夹" hint="自动同步之后的变化" onClick={() => { setAddOpen(false); onWatchFolder() }} />
              </PopoverMenu>
            )}
          </div>
          <button className="btn px-3" onClick={onManageFolders}>管理文件夹</button>
          <button className="icon-btn" onClick={onOpenSettings} title="索引设置" aria-label="索引设置">⚙</button>
          <div className="relative" data-toolbar-menu>
            <button
              className="icon-btn text-[16px]"
              onClick={() => { setMoreOpen((v) => !v); setAddOpen(false) }}
              title="更多操作"
              aria-label="更多操作"
            >
              ···
            </button>
            {moreOpen && (
              <PopoverMenu className="absolute right-0 top-full z-40 mt-2 w-56">
                <PopoverItem label={duplicateScan.running ? '查重中…' : '查找重复视频'} disabled={duplicateScan.running || processing} onClick={runDuplicateScan} />
                <PopoverItem label="重新扫描所有文件夹" disabled={processing} onClick={() => { setMoreOpen(false); onRescan() }} />
                <PopoverItem label="重建全部索引" disabled={processing || indexing} onClick={() => { setMoreOpen(false); onReindex() }} />
              </PopoverMenu>
            )}
          </div>
        </div>
      </div>

      <div className="flex min-h-12 flex-wrap items-center gap-2 border-t border-line/60 px-4 py-2">
            <button className={`btn px-2.5 py-1.5 text-[11.5px] ${treeVisible ? 'border-accent/50 bg-row-selected font-medium text-accent' : ''}`} onClick={() => !treeVisible && onToggleTree()} aria-pressed={treeVisible}>文件夹</button>
            <button className={`btn px-2.5 py-1.5 text-[11.5px] ${!treeVisible ? 'border-accent/50 bg-row-selected font-medium text-accent' : ''}`} onClick={() => treeVisible && onToggleTree()} aria-pressed={!treeVisible}>全部视频</button>
            <div className="relative min-w-[180px] max-w-sm flex-1">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tertiary">⌕</span>
              <input
                ref={filterInputRef}
                value={query.keyword ?? ''}
                onChange={(e) => onSetQuery({ ...query, keyword: e.target.value, offset: 0 })}
                placeholder="搜索视频"
                aria-label="搜索视频"
                className="w-full rounded-lg border border-line bg-surface-2 py-1.5 pl-8 pr-3 text-[12.5px] outline-none placeholder:text-tertiary focus:border-accent/60"
              />
            </div>
            <select
              value={query.status ?? 'all'}
              onChange={(e) => onSetQuery({ ...query, status: e.target.value as VideoQuery['status'], offset: 0 })}
              className="rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-[12px] outline-none"
              aria-label="筛选索引状态"
            >
              <option value="all">全部状态</option><option value="ready">已索引</option><option value="pending">待索引</option>
              <option value="indexing">索引中</option><option value="failed">索引失败</option>
            </select>
            <select
              value={query.sort ?? 'added'}
              onChange={(e) => onSetQuery(sortVideoQuery(query, e.target.value as NonNullable<VideoQuery['sort']>))}
              className="rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-[12px] outline-none"
              aria-label="排序视频"
            >
              <option value="added">最近添加</option><option value="name">名称</option>
              <option value="size">大小</option><option value="duration">时长</option>
            </select>
            <button
              className="btn px-2.5 py-1.5 text-[11.5px]"
              onClick={() => onSetQuery(reverseVideoSort(query))}
              title={query.order === 'asc' ? '当前升序，切换为降序' : '当前降序，切换为升序'}
              aria-label={query.order === 'asc' ? '升序，切换为降序' : '降序，切换为升序'}
            >
              {query.order === 'asc' ? '↑ 升序' : '↓ 降序'}
            </button>
            {videos.length > 0 && <button className="btn px-2.5 py-1.5 text-[11.5px]" onClick={onSelectAll} title="选择当前展开的所有视频">全选</button>}
            {selectedVideoIds.size > 0 ? (
              <div className="flex items-center gap-2 border-l border-line pl-2">
                <span className="whitespace-nowrap text-[11.5px] font-medium text-accent">已选 {selectedVideoIds.size}</span>
                <button className="btn py-1.5 text-[11.5px]" disabled={processing || indexing} onClick={() => onReindex([...selectedVideoIds])}>重建索引</button>
                <button className="btn btn-danger py-1.5 text-[11.5px]" disabled={videoRemoval.running} onClick={async () => {
                  const ids = [...selectedVideoIds]
                  if (!await confirm({ title: '移除所选视频', message: `从索引库移除选中的 ${ids.length} 个视频？\n不会删除磁盘文件。`, confirmLabel: `移除 ${ids.length} 个`, danger: true })) return
                  await videoRemoval.run(async () => {
                    const removedIds = await onRemoveVideos(ids)
                    if (removedIds.length === ids.length) clearSelection()
                  })
                }}>移除</button>
                <button className="text-[11.5px] text-tertiary hover:text-primary" onClick={clearSelection}>取消</button>
              </div>
            ) : null}
      </div>
    </div>
  )
}

