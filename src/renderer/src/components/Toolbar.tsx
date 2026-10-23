import { useEffect, useState } from 'react'
import type { DuplicatePair, IndexerStatus, SamplingMode, VideoQuery, VideoRecord } from '@shared/types'
import type { ImportProgressEvent } from '../lib/importProgress'
import { reverseVideoSort, sortVideoQuery } from '../lib/videoSort'

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
  const {
    busy, importProgress, indexStatus,
    query, onSetQuery, videos, total, selectedVideoIds, onSelectAll, treeVisible, onToggleTree,
    onImportFiles, onImportFolder, onWatchFolder, onManageFolders, onOpenSettings,
    onFindDuplicates, onDuplicatesResolved, onReindex, onRescan, onRemoveVideos,
    clearSelection, filterInputRef
  } = props
  const [addOpen, setAddOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [scanningDuplicates, setScanningDuplicates] = useState(false)
  const [removingVideos, setRemovingVideos] = useState(false)
  const importing = Boolean(importProgress || busy?.includes('导入') || busy?.includes('扫描') || busy?.includes('监视目录'))
  const processing = Boolean(busy || importProgress)
  const indexing = Boolean(indexStatus?.running)
  const progressLabel = importProgress
    ? importProgress.total > 0
      ? `导入 ${importProgress.processed}/${importProgress.total} · 新增 ${importProgress.added}`
      : `正在遍历文件 · 已发现 ${importProgress.processed}`
    : busy ?? (indexing ? `索引 ${indexStatus?.done ?? 0}/${indexStatus?.total ?? 0}` : null)
  useEffect(() => { setAddOpen(false); setMoreOpen(false) }, [selectedVideoIds])
  useEffect(() => {
    if (!addOpen && !moreOpen) return
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-toolbar-menu]')) {
        setAddOpen(false)
        setMoreOpen(false)
      }
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopImmediatePropagation()
        setAddOpen(false)
        setMoreOpen(false)
      }
    }
    document.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('keydown', escape, true)
    }
  }, [addOpen, moreOpen])

  const runDuplicateScan = () => {
    if (scanningDuplicates) return
    setMoreOpen(false)
    setScanningDuplicates(true)
    void onFindDuplicates()
      .then((pairs) => { if (pairs !== null) onDuplicatesResolved(pairs) })
      .finally(() => setScanningDuplicates(false))
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
              <Menu align="right">
                <MenuItem label="视频文件" hint="可切换所有文件，由 FFmpeg 验证" onClick={() => { setAddOpen(false); onImportFiles() }} />
                <MenuItem label="导入文件夹" hint="扫描一次，不持续监视" onClick={() => { setAddOpen(false); onImportFolder() }} />
                <MenuItem label="监视文件夹" hint="自动同步之后的变化" onClick={() => { setAddOpen(false); onWatchFolder() }} />
              </Menu>
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
              <Menu align="right">
                <MenuItem label={scanningDuplicates ? '查重中…' : '查找重复视频'} disabled={scanningDuplicates || processing} onClick={runDuplicateScan} />
                <MenuItem label="重新扫描所有文件夹" disabled={processing} onClick={() => { setMoreOpen(false); onRescan() }} />
                <MenuItem label="重建全部索引" disabled={processing || indexing} onClick={() => { setMoreOpen(false); onReindex() }} />
              </Menu>
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
                <button className="btn btn-danger py-1.5 text-[11.5px]" disabled={removingVideos} onClick={async () => {
                  const ids = [...selectedVideoIds]
                  if (!window.confirm(`从索引库移除选中的 ${ids.length} 个视频？\n（不会删除磁盘文件）`)) return
                  setRemovingVideos(true)
                  try {
                    const removedIds = await onRemoveVideos(ids)
                    if (removedIds.length === ids.length) clearSelection()
                  } finally {
                    setRemovingVideos(false)
                  }
                }}>移除</button>
                <button className="text-[11.5px] text-tertiary hover:text-primary" onClick={clearSelection}>取消</button>
              </div>
            ) : null}
      </div>
    </div>
  )
}

function Menu({ children, align }: { children: React.ReactNode; align: 'right' }) {
  return <div className={`popover absolute top-full z-40 mt-2 w-56 p-1.5 ${align === 'right' ? 'right-0' : 'left-0'}`}>{children}</div>
}

function MenuItem({ label, hint, disabled, onClick }: { label: string; hint?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button className="flex w-full flex-col rounded-lg px-3 py-2 text-left hover:bg-surface-3 disabled:opacity-50" disabled={disabled} onClick={onClick}>
      <span className="text-[12.5px] text-primary">{label}</span>
      {hint && <span className="mt-0.5 text-[10.5px] text-tertiary">{hint}</span>}
    </button>
  )
}
