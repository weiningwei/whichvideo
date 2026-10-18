import { useState } from 'react'
import type { DuplicatePair, SamplingMode, VideoQuery, VideoRecord } from '@shared/types'

interface ToolbarProps {
  query: VideoQuery
  onSetQuery: (query: VideoQuery) => void
  videos: VideoRecord[]
  total: number
  selectedVideoIds: Set<number>
  treeVisible: boolean
  onToggleTree: () => void
  onImportFiles: () => void
  onImportFolder: () => void
  onWatchFolder: () => void
  onManageFolders: () => void
  onOpenSettings: () => void
  onFindDuplicates: (minScore?: number) => Promise<DuplicatePair[]>
  onDuplicatesResolved: (pairs: DuplicatePair[]) => void
  onReindex: (videoIds?: number[], mode?: SamplingMode) => void
  onRescan: (folderId?: number) => void
  onRemoveVideos: (videoIds: number[]) => void
  clearSelection: () => void
  filterInputRef: React.RefObject<HTMLInputElement | null>
}

export function Toolbar(props: ToolbarProps) {
  const {
    query, onSetQuery, videos, total, selectedVideoIds, treeVisible, onToggleTree,
    onImportFiles, onImportFolder, onWatchFolder, onManageFolders, onOpenSettings,
    onFindDuplicates, onDuplicatesResolved, onReindex, onRescan, onRemoveVideos,
    clearSelection, filterInputRef
  } = props
  const [addOpen, setAddOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [scanningDuplicates, setScanningDuplicates] = useState(false)

  const runDuplicateScan = () => {
    if (scanningDuplicates) return
    setMoreOpen(false)
    setScanningDuplicates(true)
    void onFindDuplicates().then(onDuplicatesResolved).finally(() => setScanningDuplicates(false))
  }

  return (
    <div className="shrink-0 border-b border-line bg-surface-1">
      <div className="flex h-14 items-center gap-3 px-4">
        <button
          className={`icon-btn ${treeVisible ? 'bg-surface-3 text-primary' : ''}`}
          onClick={onToggleTree}
          title="显示或隐藏文件夹 (G)"
          aria-label="切换文件夹导航"
        >
          ☰
        </button>
        <div>
          <h1 className="text-[15px] font-semibold text-primary">视频库</h1>
          <div className="text-[10.5px] tabular-nums text-tertiary">{total} 个视频</div>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <div className="relative">
            <button
              className="btn border-accent-strong bg-accent px-3.5 text-surface-0 hover:opacity-90"
              onClick={() => { setAddOpen((v) => !v); setMoreOpen(false) }}
              aria-expanded={addOpen}
            >
              ＋ 添加
            </button>
            {addOpen && (
              <Menu align="right">
                <MenuItem label="视频文件" hint="选择一个或多个文件" onClick={() => { setAddOpen(false); onImportFiles() }} />
                <MenuItem label="导入文件夹" hint="扫描一次，不持续监视" onClick={() => { setAddOpen(false); onImportFolder() }} />
                <MenuItem label="监视文件夹" hint="自动同步之后的变化" onClick={() => { setAddOpen(false); onWatchFolder() }} />
              </Menu>
            )}
          </div>
          <button className="btn px-3" onClick={onManageFolders}>监视目录</button>
          <button className="icon-btn" onClick={onOpenSettings} title="索引设置" aria-label="索引设置">⚙</button>
          <div className="relative">
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
                <MenuItem label={scanningDuplicates ? '查重中…' : '查找重复视频'} onClick={runDuplicateScan} />
                <MenuItem label="重新扫描监视目录" onClick={() => { setMoreOpen(false); onRescan() }} />
                <MenuItem label="重建全部索引" onClick={() => { setMoreOpen(false); onReindex() }} />
              </Menu>
            )}
          </div>
        </div>
      </div>

      <div className="flex min-h-12 items-center gap-2 border-t border-line/60 px-4 py-2">
        {selectedVideoIds.size > 0 ? (
          <>
            <span className="mr-2 text-[12px] font-medium text-accent">已选 {selectedVideoIds.size} 项</span>
            <button className="btn py-1.5 text-[12px]" onClick={() => onReindex([...selectedVideoIds])}>重建索引</button>
            <button
              className="btn btn-danger py-1.5 text-[12px] hover:bg-bad/10"
              onClick={() => {
                const ids = [...selectedVideoIds]
                if (!window.confirm(`从索引库移除选中的 ${ids.length} 个视频？\n（不会删除磁盘文件）`)) return
                onRemoveVideos(ids)
                clearSelection()
              }}
            >
              移除
            </button>
            <button className="ml-auto text-[11.5px] text-tertiary hover:text-primary" onClick={clearSelection}>取消选择</button>
          </>
        ) : (
          <>
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
              onChange={(e) => onSetQuery({ ...query, sort: e.target.value as VideoQuery['sort'] })}
              className="rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-[12px] outline-none"
              aria-label="排序视频"
            >
              <option value="added">最近添加</option><option value="name">名称</option>
              <option value="size">大小</option><option value="duration">时长</option>
            </select>
            <span className="ml-1 text-[11px] tabular-nums text-tertiary">显示 {videos.length}</span>
          </>
        )}
      </div>
    </div>
  )
}

function Menu({ children, align }: { children: React.ReactNode; align: 'right' }) {
  return <div className={`popover absolute top-full z-40 mt-2 w-56 p-1.5 ${align === 'right' ? 'right-0' : 'left-0'}`}>{children}</div>
}

function MenuItem({ label, hint, onClick }: { label: string; hint?: string; onClick: () => void }) {
  return (
    <button className="flex w-full flex-col rounded-lg px-3 py-2 text-left hover:bg-surface-3" onClick={onClick}>
      <span className="text-[12.5px] text-primary">{label}</span>
      {hint && <span className="mt-0.5 text-[10.5px] text-tertiary">{hint}</span>}
    </button>
  )
}
