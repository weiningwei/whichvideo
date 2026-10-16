import { useMemo, useRef, useState, type ReactNode } from 'react'
import type { DuplicatePair, SamplingMode, VideoQuery, VideoRecord, WatchedFolder } from '@shared/types'
import { blockModifierTextSelection } from '../lib/selection'
import { useVideoCursor } from '../hooks/useVideoCursor'
import { useLibraryShortcuts } from '../hooks/useLibraryShortcuts'
import { SidePanel } from './SidePanel'
import { VideoRow } from './VideoRow'
import { FolderHeader } from './FolderHeader'
import { Toolbar } from './Toolbar'
import { DuplicatesModal } from './DuplicatesModal'
import { FrameGallery } from './FrameGallery'

interface Props {
  folders: WatchedFolder[]
  videos: VideoRecord[]
  total: number
  query: VideoQuery
  onSetQuery: (query: VideoQuery) => void
  onAddFolder: () => void
  onAddFolderPath: (dirPath: string) => void
  /** 快捷键 I：导入视频文件（与顶栏「+ 导入视频」同一个动作） */
  onImportFiles: () => void
  onRemoveFolder: (folderId: number) => void
  onRescan: (folderId?: number) => void
  onToggleFolder: (folderId: number, enabled: boolean) => void
  onOpen: (videoId: number, atSeconds?: number) => void
  onReveal: (videoId: number) => void
  onRemoveVideo: (videoId: number) => void
  onRemoveVideos: (videoIds: number[]) => void
  onReindex: (videoIds?: number[], mode?: SamplingMode) => void
  /** 全局采样模式（视频行未设覆盖时的生效值） */
  globalSampling: 'uniform' | 'scene'
  /** 库内查重：返回相似对。耗时长（每视频一次全帧扫描），由按钮显式触发 */
  onFindDuplicates: (minScore?: number) => Promise<DuplicatePair[]>
  groupByFolder: boolean
  onToggleGroupByFolder: () => void
  selectedVideoIds: Set<number>
  expandedFolderIds: Set<number>
  isVideoSelected: (videoId: number) => boolean
  isFolderExpanded: (folderId: number) => boolean
  toggleVideoSelection: (videoId: number, shiftKey: boolean, ctrlKey: boolean) => void
  clearSelection: () => void
  selectAll: () => void
  toggleFolderExpanded: (folderId: number) => void
  expandAllFolders: () => void
  collapseAllFolders: () => void
  /** 右侧「索引设置」页的内容（由 App 传入，合并到同一栏切换） */
  sideSettings: ReactNode
}

const STATE_STYLE: Record<string, { text: string; cls: string }> = {
  watching: { text: '监听中', cls: 'border-ok/40 bg-ok/10 text-ok' },
  idle: { text: '已暂停', cls: 'border-line bg-ink-700/40 text-secondary' },
  missing: { text: '目录不存在', cls: 'border-bad/40 bg-bad/10 text-bad' },
  error: { text: '监听异常', cls: 'border-bad/40 bg-bad/10 text-bad' },
}

export function LibraryView(props: Props) {
  const {
    folders, videos, total, query, onSetQuery, groupByFolder, onToggleGroupByFolder,
    selectedVideoIds, expandedFolderIds, isVideoSelected,
    toggleVideoSelection, clearSelection, selectAll, toggleFolderExpanded
  } = props

  const [folderDrop, setFolderDrop] = useState(false)
  // 库内查重的结果与进行中标记。结果在模态里列出，关闭即弃 —— 库内容随时变化，
  // 缓存旧结果反而误导（刚删掉的视频还会出现在列表里）。
  const [duplicates, setDuplicates] = useState<DuplicatePair[] | null>(null)
  // 「查看索引帧」弹层的目标视频；null = 关闭。只存 id 对应的行对象，
  // 行被移除时弹层里的清单查询会自然失败/为空，无僵尸引用。
  const [framesVideo, setFramesVideo] = useState<VideoRecord | null>(null)
  const roots = useMemo(() => folders.map((f) => f.path), [folders])
  /** 快捷键 / 会聚焦到这里 */
  const filterInputRef = useRef<HTMLInputElement>(null)

  /** 打开「查看索引帧」弹层。VideoRow 上来的是 id，按当前列表反查行对象 */
  const openFramesViewer = (videoId: number): void => {
    setFramesVideo(videos.find((v) => v.id === videoId) ?? null)
  }

  // 分组视图：按 folderId 聚合，null folderId 归为"未分类"
  const groupedVideos = useMemo(() => {
    if (!groupByFolder) return null
    const groups = new Map<number, VideoRecord[]>()
    for (const v of videos) {
      const key = v.folderId ?? -1
      const arr = groups.get(key) ?? []
      arr.push(v)
      groups.set(key, arr)
    }
    return groups
  }, [videos, folders, groupByFolder])

  // 键盘导航与快捷操作（光标状态与导航原语在 useVideoCursor 里）
  const {
    navigableItems, focusedIndex, focusedVideoId,
    moveCursor, jumpCursor, toggleFocusedSelection, handleRowClick,
    expandFocusedFolder, collapseFocusedFolder, scrollRef
  } = useVideoCursor({ videos, groupByFolder, groupedVideos, expandedFolderIds, toggleVideoSelection, toggleFolderExpanded, clearSelection })

  /**
   * 全局键盘快捷键（光标移动 + 操作键）。「键 → 行为」集中在 useLibraryShortcuts，
   * 这里只负责把当前状态/动作喂给它。
   */
  useLibraryShortcuts({
    groupByFolder, videos, navigableItems, focusedIndex, focusedVideoId, selectedVideoIds,
    moveCursor, jumpCursor, expandFocusedFolder, collapseFocusedFolder, toggleFocusedSelection,
    selectAll, clearSelection, toggleFolderExpanded, onToggleGroupByFolder,
    onOpen: props.onOpen, onReveal: props.onReveal, onReindex: props.onReindex,
    onAddFolder: props.onAddFolder, onImportFiles: props.onImportFiles, onRescan: props.onRescan,
    onRemoveVideo: props.onRemoveVideo, onRemoveVideos: props.onRemoveVideos, filterInputRef
  })

return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-line/70">
        <Toolbar
          query={query}
          onSetQuery={onSetQuery}
          folders={folders}
          videos={videos}
          total={total}
          selectedVideoIds={selectedVideoIds}
          groupByFolder={groupByFolder}
          onToggleGroupByFolder={onToggleGroupByFolder}
          onFindDuplicates={props.onFindDuplicates}
          onDuplicatesResolved={(pairs) => setDuplicates(pairs)}
          onReindex={props.onReindex}
          onRescan={props.onRescan}
          onRemoveVideos={props.onRemoveVideos}
          clearSelection={clearSelection}
          filterInputRef={filterInputRef}
        />

        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-auto bg-ink-900">
          {/* min-w 是"低于这个宽度才允许横向滚动"的阈值，取各列下限之和：
              视频列 200（够一行缩略图+几个字）+ 状态 128（要放下两行进度条）+ 采样 80 + 操作 180。
              别设更高——文件名已改成两行显示，内容并不需要那么宽，
              阈值定高反而会凭空造出横向滚动条。 */}
          <table className="w-full min-w-[480px] border-separate border-spacing-0 text-[12px]">
            <thead className="sticky top-0 z-10 bg-ink-900/95 text-left text-[11px] uppercase tracking-wide text-tertiary backdrop-blur">
              <tr onMouseDown={blockModifierTextSelection}>
                <th className="px-3 py-2 font-medium">视频</th>
                <th className="w-32 whitespace-nowrap px-2 py-2 font-medium">状态</th>
                <th className="w-20 whitespace-nowrap px-2 py-2 font-medium">采样</th>
                {/* 操作列吸附右侧：窗口窄到表格要横向滚动时，四个按钮仍贴在视野内。
                    左侧那条线标示"这里是浮在内容之上的固定区"。 */}
                <th className="sticky right-0 w-[210px] border-l border-line/70 bg-ink-900 px-3 py-2 text-right font-medium">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {groupByFolder && groupedVideos ? (
                (() => {
                  let cursor = 0
                  return Array.from(groupedVideos.entries()).flatMap(([folderId, folderVideos]) => {
                    const groupHeaderIndex = cursor
                    cursor += 1 + folderVideos.length
                    const folder = folderId === -1 ? null : (folders.find((f) => f.id === folderId) ?? null)
                    const expanded = expandedFolderIds.has(folderId)
                    const headerFocused = focusedIndex === groupHeaderIndex

                    const rows = expanded ? folderVideos.map((video) => (
                      <VideoRow
                        key={video.id}
                        video={video}
                        roots={roots}
                        focused={focusedVideoId === video.id}
                        onOpen={props.onOpen}
                        onReveal={props.onReveal}
                        onRemove={props.onRemoveVideo}
                        onViewFrames={openFramesViewer}
                        globalSampling={props.globalSampling}
                        onSamplingChange={(id, mode) => props.onReindex([id], mode)}
                        isVideoSelected={isVideoSelected}
                        onRowClick={(shiftKey, ctrlKey) => handleRowClick(video.id, shiftKey, ctrlKey)}
                      />
                    )) : []

                    return [
                      <FolderHeader
                        key={`folder-header-${folderId}`}
                        folderId={folderId}
                        folder={folder}
                        videos={folderVideos}
                        expanded={expanded}
                        focused={headerFocused}
                        isVideoSelected={isVideoSelected}
                        toggleVideoSelection={toggleVideoSelection}
                        toggleFolderExpanded={toggleFolderExpanded}
                      />,
                      ...rows
                    ]
                  })
                })()
              ) : (
                videos.map((video) => (
                  <VideoRow
                    key={video.id}
                    video={video}
                    roots={roots}
                    focused={focusedVideoId === video.id}
                    onOpen={props.onOpen}
                    onReveal={props.onReveal}
                    onRemove={props.onRemoveVideo}
                    onViewFrames={openFramesViewer}
                    globalSampling={props.globalSampling}
                    onSamplingChange={(id, mode) => props.onReindex([id], mode)}
                    isVideoSelected={isVideoSelected}
                    onRowClick={(shiftKey, ctrlKey) => handleRowClick(video.id, shiftKey, ctrlKey)}
                  />
                ))
              )}
            </tbody>
          </table>
          {videos.length === 0 && (
            <div className="p-8 text-center text-[12.5px] text-muted">
              还没有视频。点击右上角「导入视频」选择文件，或「导入文件夹」递归导入整个目录。
            </div>
          )}
        </div>
      </section>

      <SidePanel
        onAddFolder={props.onAddFolder}
        folderCount={folders.length}
        folderDrop={folderDrop}
        onDragOver={(e) => {
          e.preventDefault()
          setFolderDrop(true)
        }}
        onDragLeave={() => setFolderDrop(false)}
        onDrop={(e) => {
          e.preventDefault()
          setFolderDrop(false)
          const dir = extractDroppedDir(e.dataTransfer)
          if (dir) props.onAddFolderPath(dir)
        }}
        folders={
          <>
            {folders.length === 0 && (
              <div className="rounded-xl border border-dashed border-line/80 p-4 text-center text-[11.5px] text-muted">
                还没有监听目录。
                <br />
                可以点「+ 添加」，也可以把文件夹直接拖到这里。
              </div>
            )}
            <div className="flex flex-col gap-2">
              {folders.map((folder) => (
                <FolderCard
                  key={folder.id}
                  folder={folder}
                  onRemove={props.onRemoveFolder}
                  onRescan={props.onRescan}
                  onToggle={props.onToggleFolder}
                />
              ))}
            </div>
          </>
        }
        settings={props.sideSettings}
      />

      {duplicates !== null && (
        <DuplicatesModal
          duplicates={duplicates}
          onClose={() => setDuplicates(null)}
          onRemoveVideos={props.onRemoveVideos}
          onPrune={(removedIds) =>
            setDuplicates((prev) =>
              prev
                ? prev.filter(
                    (x) => !removedIds.includes(x.videoA.id) && !removedIds.includes(x.videoB.id)
                  )
                : prev
            )
          }
        />
      )}

      <FrameGallery
        video={framesVideo}
        onClose={() => setFramesVideo(null)}
        onOpenFrame={(id, atSeconds) => {
          props.onOpen(id, atSeconds)
        }}
      />
    </div>
  )
}

function FolderCard({
  folder,
  onRemove,
  onRescan,
  onToggle
}: {
  folder: WatchedFolder
  onRemove: (id: number) => void
  onRescan: (id?: number) => void
  onToggle: (id: number, enabled: boolean) => void
}) {
  const style = STATE_STYLE[folder.watchState] ?? STATE_STYLE.idle
  return (
    <div className="card p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-medium text-primary" title={folder.path}>
              {folder.name}
            </span>
            {folder.pinned && (
              <span className="rounded bg-ink-700/60 px-1 text-[9.5px] text-secondary">手动</span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[10.5px] text-muted" title={folder.path}>
            {folder.path}
          </div>
        </div>
        <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] ${style.cls}`}>
          {style.text}
        </span>
      </div>

      {folder.message && (
        <div className="mt-1.5 truncate text-[10.5px] text-bad" title={folder.message}>
          {folder.message}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <button
          className="btn px-2 py-1 text-[11px] hover:bg-ink-700/70"
          onClick={() => onToggle(folder.id, !folder.enabled)}
        >
          {folder.enabled ? '暂停监听' : '恢复监听'}
        </button>
        <button className="btn px-2 py-1 text-[11px] hover:bg-ink-700/70" onClick={() => onRescan(folder.id)}>
          重新扫描
        </button>
        <button
          className="btn btn-danger ml-auto px-2 py-1 text-[11px] hover:bg-bad/10"
          onClick={() => onRemove(folder.id)}
          title="只停止监听该目录，已入库的视频记录保留"
        >
          停止监听
        </button>
      </div>
      <div className="mt-1.5 text-[10px] text-tertiary">
        {folder.recursive ? '包含子目录' : '仅当前目录'}
        {folder.lastScanAt ? ` · 上次扫描 ${new Date(folder.lastScanAt).toLocaleString('zh-CN')}` : ''}
      </div>
    </div>
  )
}

/** 从拖拽内容里尽力提取目录绝对路径（Electron 下 File.path 可用） */
function extractDroppedDir(dataTransfer: DataTransfer): string | null {
  const files = Array.from(dataTransfer.files ?? [])
  for (const file of files) {
    const path = (file as File & { path?: string }).path
    if (!path) continue
    return /[\\/][^\\/]+$/.test(path) ? path.replace(/[\\/][^\\/]+$/, '') : path
  }
  const uri = dataTransfer.getData('text/uri-list') || dataTransfer.getData('text/plain')
  if (uri) {
    const cleaned = uri.replace(/^file:\/\/\//, '').replace(/\//g, '\\')
    return decodeURIComponent(cleaned)
  }
  return null
}
