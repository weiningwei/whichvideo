import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DuplicatePair, VideoQuery, VideoRecord, WatchedFolder } from '@shared/types'
import { formatBytes, formatDuration, formatPercent, scoreLabel } from '../lib/format'
import { blockModifierTextSelection } from '../lib/selection'
import { useVideoCursor, PAGE_JUMP } from '../hooks/useVideoCursor'
import { SidePanel } from './SidePanel'
import { VideoRow } from './VideoRow'

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
  onReindex: (videoIds?: number[]) => void
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
  const [scanningDuplicates, setScanningDuplicates] = useState(false)
  const roots = useMemo(() => folders.map((f) => f.path), [folders])
  /** 快捷键 / 会聚焦到这里 */
  const filterInputRef = useRef<HTMLInputElement>(null)

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
    navigableItems, videoRowIndexes, focusedIndex, focusedRowPos, focusedVideoId,
    moveCursor, jumpCursor, toggleFocusedSelection, handleRowClick,
    expandFocusedFolder, collapseFocusedFolder, scrollRef
  } = useVideoCursor({ videos, groupByFolder, groupedVideos, expandedFolderIds, toggleVideoSelection, toggleFolderExpanded })

  /**
   * 拿到"该被操作的那个视频"：有选中就用第一个选中的，否则用焦点处的。
   *
   * 这样 Delete / 播放这类操作在"多选"和"只看一行"两种心智下都自然：
   * 先选中再按 Delete 是删多个，什么都不选直接按是删当前这一行。
   */
  const getTargetVideo = (): VideoRecord | null => {
    if (selectedVideoIds.size > 0) {
      for (const v of videos) if (selectedVideoIds.has(v.id)) return v
      return null
    }
    const item = navigableItems[focusedIndex]
    return item && item.type === 'video' ? item.video ?? null : null
  }

  /** 当前操作会作用到几个视频（用于决定要不要二次确认） */
  const getTargetCount = (): number =>
    selectedVideoIds.size > 0 ? selectedVideoIds.size : focusedVideoId === null ? 0 : 1

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return
      // 焦点在按钮上时，空格与回车应触发按钮本身，否则会出现"点一下按钮没反应又改了选中态"
      const onButton = e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement
      const mod = e.ctrlKey || e.metaKey

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          moveCursor(1, e.shiftKey, mod)
          break
        case 'ArrowUp':
          e.preventDefault()
          moveCursor(-1, e.shiftKey, mod)
          break
        case 'PageDown':
          e.preventDefault()
          jumpCursor(focusedRowPos + PAGE_JUMP, e.shiftKey)
          break
        case 'PageUp':
          e.preventDefault()
          jumpCursor(focusedRowPos - PAGE_JUMP, e.shiftKey)
          break
        case 'Home':
          if (!mod) {
            e.preventDefault()
            jumpCursor(0, e.shiftKey)
          }
          break
        case 'End':
          if (!mod) {
            e.preventDefault()
            jumpCursor(videoRowIndexes.length - 1, e.shiftKey)
          }
          break
        case 'ArrowRight':
          if (groupByFolder) {
            e.preventDefault()
            expandFocusedFolder()
          }
          break
        case 'ArrowLeft':
          if (groupByFolder) {
            e.preventDefault()
            collapseFocusedFolder()
          }
          break

        case 'Enter': {
          if (onButton) return
          e.preventDefault()
          const target = getTargetVideo()
          if (target) props.onOpen(target.id)
          break
        }
        // 空格只做选中切换（不播放）—— 与文件管理器一致，空格是"选择"不是"打开"
        case ' ':
          if (onButton) return
          e.preventDefault()
          toggleFocusedSelection(e.shiftKey, mod)
          break

        case 'l':
        case 'L':
          if (!mod) return
          e.preventDefault()
          if (focusedVideoId !== null) props.onReveal(focusedVideoId)
          break
        case 'r':
        case 'R':
          if (!mod) return
          e.preventDefault()
          if (focusedVideoId !== null) props.onReindex([focusedVideoId])
          break

        case 'a':
        case 'A':
          if (mod) {
            e.preventDefault()
            selectAll()
          }
          break
        case 'b':
        case 'B':
          // 重建全部索引。耗时较长（整库重新抽帧），但不涉及破坏性操作，不需要确认
          if (!mod) {
            e.preventDefault()
            props.onReindex()
          }
          break
        case 'i':
        case 'I':
          if (mod && e.shiftKey) {
            e.preventDefault()
            props.onAddFolder()
          } else if (!mod) {
            e.preventDefault()
            props.onImportFiles()
          }
          break
        case 's':
        case 'S':
          if (!mod) {
            e.preventDefault()
            props.onRescan()
          }
          break
        case 'g':
        case 'G':
          e.preventDefault()
          onToggleGroupByFolder()
          break

        case 'Delete':
        case 'Backspace': {
          e.preventDefault()
          const count = getTargetCount()
          if (count === 0) return
          // 一次删多个时先确认，避免误按丢掉一大片索引记录
          if (count > 1 && !window.confirm(`从索引库移除选中的 ${count} 个视频？\n（不会删除磁盘文件，可随时重新导入）`)) {
            return
          }
          if (selectedVideoIds.size > 0) {
            props.onRemoveVideos([...selectedVideoIds])
            clearSelection()
          } else {
            const target = getTargetVideo()
            if (target) props.onRemoveVideo(target.id)
          }
          break
        }
        case '/':
          e.preventDefault()
          filterInputRef.current?.focus()
          filterInputRef.current?.select()
          break
        case 'Escape':
          clearSelection()
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [groupByFolder, videos, groupedVideos, folders, expandedFolderIds, selectedVideoIds, focusedIndex, focusedRowPos, navigableItems, videoRowIndexes, focusedVideoId, onToggleGroupByFolder, props.onRemoveVideo, props.onRemoveVideos, props.onReindex, props.onImportFiles, props.onAddFolder, props.onRescan, clearSelection, selectAll, toggleVideoSelection])

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-line/70">
        {/* 工具条分两层：左侧筛选区（内容多了自己换行），右侧按钮区独立 shrink-0。
            此前是单行 flex-wrap + ml-auto，选中时「已选 N」一出现就把整个按钮组
            挤到第二行（用户反馈：选中视频后三个按钮下移）。拆开后按钮永不换行，
            计数再用 invisible 常驻占位 —— 选中前后工具条布局零变化。 */}
        <div className="flex min-w-0 items-center gap-2 border-b border-line/70 px-3 py-2.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <input
              ref={filterInputRef}
              value={query.keyword ?? ''}
              onChange={(e) => onSetQuery({ ...query, keyword: e.target.value, offset: 0 })}
              placeholder="按文件名 / 目录筛选（/ 聚焦）"
              className="w-40 rounded-lg border border-line bg-ink-900/70 px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-tertiary focus:border-accent/60"
            />
            <select
              value={String(query.folderId ?? '')}
              onChange={(e) =>
                onSetQuery({
                  ...query,
                  folderId: e.target.value === '' ? null : Number(e.target.value),
                  offset: 0
                })
              }
              className="rounded-lg border border-line bg-ink-900/70 px-2 py-1.5 text-[12.5px] outline-none focus:border-accent/60"
            >
              <option value="">全部监听目录</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <select
              value={query.status ?? 'all'}
              onChange={(e) => onSetQuery({ ...query, status: e.target.value as VideoQuery['status'], offset: 0 })}
              className="rounded-lg border border-line bg-ink-900/70 px-2 py-1.5 text-[12.5px] outline-none focus:border-accent/60"
            >
              <option value="all">全部状态</option>
              <option value="ready">已索引</option>
              <option value="pending">待索引</option>
              <option value="indexing">索引中</option>
              <option value="failed">索引失败</option>
            </select>
            <select
              value={query.sort ?? 'added'}
              onChange={(e) => onSetQuery({ ...query, sort: e.target.value as VideoQuery['sort'] })}
              className="rounded-lg border border-line bg-ink-900/70 px-2 py-1.5 text-[12.5px] outline-none focus:border-accent/60"
            >
              <option value="added">按导入时间</option>
              <option value="name">按文件名</option>
              <option value="size">按体积</option>
              <option value="duration">按时长</option>
            </select>
            <span className="text-[11.5px] text-muted">
              显示 {videos.length} / {total}
            </span>
            {/* 选中数量：多选时给出反馈（此前只能靠数竖条），也便于自查
                「标题染色是否与选中数量一致」——见 test:range 的说明。
                无选中时用 invisible 常驻占位而不是条件渲染：行宽保持不变，
                选中瞬间不会把右侧按钮挤到第二行。tabular-nums 让数字等宽。 */}
            <span
              className={`text-[11.5px] tabular-nums ${
                selectedVideoIds.size > 0 ? 'text-tertiary' : 'invisible'
              }`}
            >
              已选 {selectedVideoIds.size}
            </span>
            <span
              className="hidden text-[11px] text-tertiary lg:inline"
              title="↑/↓ 移动焦点 · Enter/Space 选中 · Ctrl+A 全选 · Esc 取消 · G 切换分组"
            >
              ↑↓ 移动 · Enter 选中
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {selectedVideoIds.size > 0 && (
              <>
                <button
                  className="btn text-[12px] hover:bg-ink-700/70"
                  onClick={() => props.onReindex([...selectedVideoIds])}
                  title="把选中的视频重新排入索引队列"
                >
                  重建索引（{selectedVideoIds.size}）
                </button>
                <button
                  className="btn btn-danger text-[12px] hover:bg-bad/10"
                  onClick={() => {
                    const ids = [...selectedVideoIds]
                    if (!window.confirm(`从索引库移除选中的 ${ids.length} 个视频？\n（不会删除磁盘文件，可随时重新导入）`)) return
                    props.onRemoveVideos(ids)
                    clearSelection()
                  }}
                  title="从索引库移除选中的视频（不删磁盘文件）"
                >
                  移除（{selectedVideoIds.size}）
                </button>
              </>
            )}
            <button
              className={`btn text-[12px] hover:bg-ink-700/70 ${groupByFolder ? 'bg-accent/20 border-accent/40' : ''}`}
              onClick={onToggleGroupByFolder}
              title="按文件夹分组/平铺 (G)"
            >
              {groupByFolder ? '📁 分组' : '📋 平铺'}
            </button>
            <button
              className="btn text-[12px] hover:bg-ink-700/70"
              onClick={() => {
                if (scanningDuplicates) return
                setScanningDuplicates(true)
                void props
                  .onFindDuplicates()
                  .then((pairs) => setDuplicates(pairs))
                  .finally(() => setScanningDuplicates(false))
              }}
              disabled={scanningDuplicates}
              title="找出库内画面高度相似的视频对（代表帧互搜，库越大越慢）"
            >
              {scanningDuplicates ? '查重中…' : '查重'}
            </button>
            <button className="btn text-[12px] hover:bg-ink-700/70" onClick={() => props.onReindex()}>
              重建全部索引
            </button>
            <button className="btn text-[12px] hover:bg-ink-700/70" onClick={() => props.onRescan()}>
              重新扫描目录
            </button>
          </div>
        </div>

        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-auto bg-ink-900">
          {/* min-w 是"低于这个宽度才允许横向滚动"的阈值，取三列的下限之和：
              视频列 200（够一行缩略图+几个字）+ 状态 96 + 操作 180。
              别设更高——文件名已改成两行显示，内容并不需要那么宽，
              阈值定高反而会凭空造出横向滚动条。 */}
          <table className="w-full min-w-[480px] border-separate border-spacing-0 text-[12px]">
            <thead className="sticky top-0 z-10 bg-ink-900/95 text-left text-[11px] uppercase tracking-wide text-tertiary backdrop-blur">
              <tr onMouseDown={blockModifierTextSelection}>
                <th className="px-3 py-2 font-medium">视频</th>
                <th className="w-24 whitespace-nowrap px-2 py-2 font-medium">状态</th>
                {/* 操作列吸附右侧：窗口窄到表格要横向滚动时，四个按钮仍贴在视野内。
                    左侧那条线标示"这里是浮在内容之上的固定区"。 */}
                <th className="sticky right-0 w-[180px] border-l border-line/70 bg-ink-900 px-3 py-2 text-right font-medium">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {groupByFolder && groupedVideos ? (
                Array.from(groupedVideos.entries()).flatMap(([folderId, folderVideos]) => {
                  const folder = folderId === -1 ? null : folders.find((f) => f.id === folderId)
                  const displayName = folderId === -1 ? '未分类' : (folder?.name ?? `文件夹 #${folderId}`)
                  const expanded = expandedFolderIds.has(folderId)

                  const groupSelected = folderVideos.length > 0 && folderVideos.every((v) => isVideoSelected(v.id))
                  const groupPartial =
                    !groupSelected && folderVideos.some((v) => isVideoSelected(v.id))

                  const toggleGroup = () => {
                    const target = !groupSelected
                    folderVideos.forEach((v) => {
                      if (target !== isVideoSelected(v.id)) toggleVideoSelection(v.id, false, false)
                    })
                  }

                  // 分组标题不再有「键盘焦点」态：↑↓ 只在视频行间移动，光标不会停在标题上。
                  // 之前用 focusedIndex === groupIdx 判断，但那条件在光标与选中合一后
                  // 永远不成立，留着只会误导后来人以为标题能被键盘选中。
                  // 标题行拆成两格而不是一个 colSpan=3：跨三列的 td 会把操作列一起盖住，
                  // 右侧的吸附格与分隔线就断了。第二格留空，只为延续那条竖线。
                  const header = (
                    <tr
                      key={`folder-header-${folderId}`}
                      onMouseDown={blockModifierTextSelection}
                      className="border-t border-line/40"
                    >
                      <td colSpan={2} className="bg-row-group px-3 py-2">
                        <div className="flex items-center gap-2 text-[12px] font-medium text-secondary">
                          {/* 全选该组：点竖条。热区做到 12px 宽（视觉仍是 2px），
                              否则这个 2px 的细条根本点不中。 */}
                          <span
                            className="-m-1 flex h-5 w-3 shrink-0 cursor-pointer items-center justify-center"
                            onClick={toggleGroup}
                            title={groupSelected ? '取消全选该组' : '全选该组'}
                            role="checkbox"
                            aria-checked={groupSelected}
                            aria-label="全选该组"
                          >
                            <span
                              className={`h-3.5 w-[2px] rounded-full transition ${
                                groupSelected ? 'bg-accent' : groupPartial ? 'bg-accent/45' : 'bg-transparent'
                              }`}
                            />
                          </span>
                          {/* 展开/收起：整块（竖条右侧到视频数）都可点。
                              此前文件夹名字被"全选该组"占用了，只能点小三角 ——
                              那不符合直觉，名字就该是展开收起的主热区。 */}
                          <span
                            className="-my-2 flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2 hover:text-primary"
                            onClick={() => toggleFolderExpanded(folderId)}
                            title={expanded ? '收起该目录' : '展开该目录'}
                          >
                            <span
                              className="select-none transition-transform duration-150"
                              style={{ transform: `rotate(${expanded ? 0 : -90}deg)` }}
                            >
                              ▼
                            </span>
                            <span className="truncate font-medium">{displayName}</span>
                            <span className="ml-auto shrink-0 text-[11px] font-normal text-muted">
                              {folderVideos.length} 个视频
                            </span>
                          </span>
                        </div>
                      </td>
                      {/* 空的操作格：只为让吸附列的左侧分隔线在标题行也连续 */}
                      <td className="sticky right-0 w-[180px] border-l border-line/70 bg-row-group" />
                    </tr>
                  )
                  const rows = expanded ? folderVideos.map((video) => (
                    <VideoRow
                      key={video.id}
                      video={video}
                      roots={roots}
                      focused={focusedVideoId === video.id}
                      onOpen={props.onOpen}
                      onReveal={props.onReveal}
                      onRemove={props.onRemoveVideo}
                      onReindex={(id) => props.onReindex([id])}
                      isVideoSelected={isVideoSelected}
                      onRowClick={(shiftKey, ctrlKey) => handleRowClick(video.id, shiftKey, ctrlKey)}
                    />
                  )) : []

                  return [header, ...rows]
                })
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
                    onReindex={(id) => props.onReindex([id])}
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
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-ink-950/70 p-6 pt-[8vh] backdrop-blur-sm"
          onClick={() => setDuplicates(null)}
        >
          <div
            className="max-h-[80vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-line bg-surface-1 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-[14px] font-medium text-primary">库内查重结果</div>
                <div className="text-[11px] text-muted">
                  {duplicates.length === 0
                    ? '没有发现画面高度相似的视频对'
                    : `发现 ${duplicates.length} 对画面高度相似的视频（按相似度排序）`}
                  {' · '}单帧判据：同剧不同集的相同场景可能误报，请自行核对
                </div>
              </div>
              <button className="btn px-2 py-1 text-[11px]" onClick={() => setDuplicates(null)}>
                关闭
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {duplicates.map((pair) => {
                const smaller = pair.videoA.size <= pair.videoB.size ? pair.videoA : pair.videoB
                return (
                  <div key={`${pair.videoA.id}-${pair.videoB.id}`} className="rounded-xl border border-line p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[12px] text-primary">
                        {pair.videoA.name}
                        <span className="mx-1.5 text-tertiary">↔</span>
                        {pair.videoB.name}
                      </div>
                      <div className={`shrink-0 text-[13px] font-semibold ${scoreLabel(pair.score).includes('重复') || pair.score >= 0.95 ? 'text-bad' : 'text-warn'}`}>
                        {formatPercent(pair.score)}
                      </div>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted">
                      <span>结构 {(pair.hashScore * 100).toFixed(0)}% · 颜色 {(pair.colorScore * 100).toFixed(0)}%</span>
                      <span>命中于 {formatDuration(pair.timeSeconds)}</span>
                      <span>
                        {pair.videoA.name} {formatBytes(pair.videoA.size)} / {pair.videoB.name} {formatBytes(pair.videoB.size)}
                      </span>
                      <button
                        className="btn px-1.5 py-0.5 text-[10.5px] hover:bg-ink-700/70"
                        onClick={() => {
                          props.onOpen(pair.videoA.id, pair.timeSeconds)
                        }}
                        title="从命中位置播放 B（mpv/PotPlayer/VLC）"
                      >
                        从 {formatDuration(pair.timeSeconds)} 播放 B
                      </button>
                      <button
                        className="btn btn-danger px-1.5 py-0.5 text-[10.5px] hover:bg-bad/10"
                        onClick={() => {
                          props.onRemoveVideo(smaller.id)
                          setDuplicates((prev) =>
                            prev
                              ? prev.filter(
                                  (x) => x.videoA.id !== smaller.id && x.videoB.id !== smaller.id
                                )
                              : prev
                          )
                        }}
                        title={`移除体积较小的（${formatBytes(smaller.size)}），不删磁盘文件`}
                      >
                        移除较小的（{formatBytes(smaller.size)}）
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
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
