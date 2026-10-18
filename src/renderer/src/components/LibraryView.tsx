import { useMemo, useRef, useState, type ReactNode } from 'react'
import type { DuplicatePair, SamplingMode, VideoQuery, VideoRecord, WatchedFolder } from '@shared/types'
import { blockModifierTextSelection } from '../lib/selection'
import { useVideoCursor } from '../hooks/useVideoCursor'
import { useLibraryShortcuts } from '../hooks/useLibraryShortcuts'
import { buildFolderTree, pathSegments } from '../lib/libraryTree'
import { SidePanel } from './SidePanel'
import { VideoRow } from './VideoRow'
import { FolderTree } from './FolderTree'
import { Toolbar } from './Toolbar'
import { DuplicatesModal } from './DuplicatesModal'
import { FrameGallery } from './FrameGallery'

interface Props {
  folders: WatchedFolder[]
  /** 当前可见视频（已按地址栏目录过滤） */
  videos: VideoRecord[]
  total: number
  query: VideoQuery
  onSetQuery: (query: VideoQuery) => void
  onAddFolder: () => void
  onAddFolderPath: (dirPath: string) => void
  /** 一次性递归导入目录，不建立监听。 */
  onImportFolder: () => void
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
  // 地址栏 / 树
  selectedDir: string | null
  onSelectDir: (dir: string | null) => void
  treeVisible: boolean
  onToggleTree: () => void
  // 选中
  selectedVideoIds: Set<number>
  isVideoSelected: (videoId: number) => boolean
  toggleVideoSelection: (videoId: number, shiftKey: boolean, ctrlKey: boolean) => void
  clearSelection: () => void
  selectAll: () => void
  setSelectedIds: (ids: number[], selected: boolean) => void
  /** 右侧「索引设置」页的内容（由 App 传入，合并到同一栏切换） */
  sideSettings: ReactNode
}

const STATE_STYLE: Record<string, { text: string; cls: string }> = {
  watching: { text: '监听中', cls: 'border-ok/40 bg-ok/10 text-ok' },
  idle: { text: '已暂停', cls: 'border-line bg-ink-700/40 text-secondary' },
  missing: { text: '目录不存在', cls: 'border-bad/40 bg-bad/10 text-bad' },
  error: { text: '监听异常', cls: 'border-bad/40 bg-bad/10 text-bad' }
}

export function LibraryView(props: Props) {
  const {
    folders, videos, total, query, onSetQuery, selectedDir, onSelectDir,
    treeVisible, onToggleTree, selectedVideoIds, isVideoSelected,
    toggleVideoSelection, clearSelection, selectAll, setSelectedIds
  } = props

  const [folderDrop, setFolderDrop] = useState(false)
  const [drawer, setDrawer] = useState<'folders' | 'settings' | null>(null)
  // 库内查重的结果与进行中标记。结果在模态里列出，关闭即弃 —— 库内容随时变化，
  // 缓存旧结果反而误导（刚删掉的视频还会出现在列表里）。
  const [duplicates, setDuplicates] = useState<DuplicatePair[] | null>(null)
  // 「查看索引帧」弹层的目标视频；null = 关闭。只存 id 对应的行对象，
  // 行被移除时弹层里的清单查询会自然失败/为空，无僵尸引用。
  const [framesVideo, setFramesVideo] = useState<VideoRecord | null>(null)
  /** 快捷键 / 会聚焦到这里 */
  const filterInputRef = useRef<HTMLInputElement>(null)

  /** 打开「查看索引帧」弹层。VideoRow 上来的是 id，按当前列表反查行对象 */
  const openFramesViewer = (videoId: number): void => {
    setFramesVideo(videos.find((v) => v.id === videoId) ?? null)
  }

  const roots = useMemo(() => folders.map((f) => f.path), [folders])
  // 地址栏面包屑：从监听根到当前选中目录的路径段
  const treeRoots = useMemo(() => buildFolderTree(folders, videos), [folders, videos])
  const breadcrumb = useMemo(
    () => (selectedDir === null ? [] : pathSegments(selectedDir, treeRoots)),
    [selectedDir, treeRoots]
  )

  // 表头全选框状态：可见视频是否全部选中 / 部分选中
  const visibleIds = useMemo(() => videos.map((v) => v.id), [videos])
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedVideoIds.has(id))
  const someSelected = visibleIds.some((id) => selectedVideoIds.has(id))

  // 键盘导航与快捷操作（光标状态与导航原语在 useVideoCursor 里）
  const {
    navigableItems, focusedIndex, focusedVideoId,
    moveCursor, jumpCursor, toggleFocusedSelection, handleRowClick, scrollRef
  } = useVideoCursor({ videos, toggleVideoSelection })

  /**
   * 全局键盘快捷键（光标移动 + 操作键）。「键 → 行为」集中在 useLibraryShortcuts，
   * 这里只负责把当前状态/动作喂给它。
   */
  useLibraryShortcuts({
    videos, navigableItems, focusedIndex, focusedVideoId, selectedVideoIds,
    moveCursor, jumpCursor, toggleFocusedSelection,
    selectAll, clearSelection, onToggleTree,
    onOpen: props.onOpen, onReveal: props.onReveal, onReindex: props.onReindex,
    onImportFolder: props.onImportFolder, onImportFiles: props.onImportFiles, onRescan: props.onRescan,
    onRemoveVideo: props.onRemoveVideo, onRemoveVideos: props.onRemoveVideos, filterInputRef
  })

  const headerCheckRef = useRef<HTMLInputElement>(null)

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      {treeVisible && (
        <FolderTree
          folders={folders}
          videos={videos}
          selectedDir={selectedDir}
          onSelectDir={onSelectDir}
        />
      )}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Toolbar
          query={query}
          onSetQuery={onSetQuery}
          videos={videos}
          total={total}
          selectedVideoIds={selectedVideoIds}
          treeVisible={treeVisible}
          onToggleTree={onToggleTree}
          onImportFiles={props.onImportFiles}
          onImportFolder={props.onImportFolder}
          onWatchFolder={props.onAddFolder}
          onManageFolders={() => setDrawer('folders')}
          onOpenSettings={() => setDrawer('settings')}
          onFindDuplicates={props.onFindDuplicates}
          onDuplicatesResolved={(pairs) => setDuplicates(pairs)}
          onReindex={props.onReindex}
          onRescan={props.onRescan}
          onRemoveVideos={props.onRemoveVideos}
          clearSelection={clearSelection}
          filterInputRef={filterInputRef}
        />

        {/* 地址栏（面包屑）：当前所在目录，点段回跳；非整库时提供「整库」入口 */}
        {selectedDir !== null && (
          <div className="flex min-w-0 items-center gap-1 border-b border-line/70 bg-surface-1 px-4 py-1.5 text-[11px]">
              <button
                className="rounded px-1 text-secondary hover:bg-ink-700/70 hover:text-primary"
                onClick={() => onSelectDir(null)}
                title="回到整库"
              >
                全部视频
              </button>
              {breadcrumb.map((seg, i) => (
                <span key={seg.path} className="flex min-w-0 items-center gap-1">
                  <span className="text-tertiary">/</span>
                  <button
                    className={`max-w-[180px] truncate rounded px-1 hover:bg-ink-700/70 ${
                      i === breadcrumb.length - 1 ? 'font-medium text-accent' : 'text-secondary'
                    }`}
                    onClick={() => onSelectDir(seg.path)}
                    title={seg.path}
                  >
                    {seg.name}
                  </button>
                </span>
              ))}
          </div>
        )}

        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-auto bg-surface-1">
          <table className="w-full min-w-[650px] border-separate border-spacing-0 text-[12px]">
            <thead className="sticky top-0 z-10 bg-surface-1/95 text-left text-[10.5px] text-tertiary backdrop-blur">
              <tr onMouseDown={blockModifierTextSelection}>
                <th className="w-9 px-0 py-2 text-center">
                  <input
                    ref={(el) => {
                      headerCheckRef.current = el
                      if (el) el.indeterminate = someSelected && !allSelected
                    }}
                    type="checkbox"
                    checked={allSelected}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => setSelectedIds(visibleIds, !allSelected)}
                    aria-label="全选当前视图"
                    className="h-3.5 w-3.5 cursor-pointer accent-accent"
                  />
                </th>
                <th className="px-3 py-2 font-medium">视频</th>
                <th className="w-32 whitespace-nowrap px-2 py-2 font-medium">状态</th>
                <th className="w-16 whitespace-nowrap px-2 py-2 font-medium">时长</th>
                <th className="w-[72px] whitespace-nowrap px-2 py-2 font-medium">大小</th>
                <th className="sticky right-0 w-28 bg-surface-1 px-3 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {videos.map((video) => (
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
                  onToggleCheck={(id) => toggleVideoSelection(id, false, true)}
                  onOpenDouble={(id) => props.onOpen(id)}
                />
              ))}
            </tbody>
          </table>
          {videos.length === 0 && (
            <div className="mx-auto flex max-w-sm flex-col items-center px-6 py-20 text-center">
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-surface-3 text-xl text-tertiary">▶</div>
              <div className="mt-4 text-[14px] font-medium text-primary">{total ? '没有符合条件的视频' : '开始建立你的视频库'}</div>
              <div className="mt-1 text-[11.5px] text-tertiary">{total ? '试试清除搜索或更换筛选条件' : '添加视频或文件夹即可开始索引'}</div>
              {!total && <button className="btn mt-4 border-accent-strong bg-accent text-surface-0" onClick={props.onImportFiles}>＋ 添加视频</button>}
            </div>
          )}
        </div>
      </section>

      <SidePanel
        mode={drawer}
        onClose={() => setDrawer(null)}
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
              <div className="rounded-xl border border-dashed border-line p-6 text-center text-[11.5px] text-tertiary">
                将文件夹拖到这里，或点击添加
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
    <div className="rounded-xl border border-line bg-surface-1 p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-medium text-primary" title={folder.path}>
              {folder.name}
            </span>
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

      <div className="mt-2 flex items-center gap-1">
        <button
          className="btn px-2 py-1 text-[11px]"
          onClick={() => onToggle(folder.id, !folder.enabled)}
        >
          {folder.enabled ? '暂停监听' : '恢复监听'}
        </button>
        <button className="btn px-2 py-1 text-[11px]" onClick={() => onRescan(folder.id)}>
          扫描
        </button>
        <button
          className="ml-auto rounded-lg px-2 py-1 text-[11px] text-bad hover:bg-bad/10"
          onClick={() => onRemove(folder.id)}
          title="只停止监听该目录，已入库的视频记录保留"
        >
          移除
        </button>
      </div>
    </div>
  )
}

/** 从拖拽内容里尽力提取目录绝对路径（桌面 WebView 的 File.path 扩展可用时优先）。 */
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
