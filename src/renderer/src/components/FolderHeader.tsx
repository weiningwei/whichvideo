import type { VideoRecord, WatchedFolder } from '@shared/types'
import { blockModifierTextSelection } from '../lib/selection'

interface FolderHeaderProps {
  folderId: number
  folder: WatchedFolder | null
  videos: VideoRecord[]
  expanded: boolean
  focused: boolean
  isVideoSelected: (videoId: number) => boolean
  toggleVideoSelection: (videoId: number, shiftKey: boolean, ctrlKey: boolean) => void
  toggleFolderExpanded: (folderId: number) => void
}

/**
 * 分组视图里的「文件夹标题行」。
 *
 * 选中视觉态的唯一 owner —— 此前这段逻辑内联在 LibraryView 的表体渲染里，
 * 同时依赖 isVideoSelected（选中层）、folderVideos（分组）、expandedFolderIds
 * （展开）、focusedIndex（光标）四路状态现场派生，改一处要同步 4~5 个派生量，
 * 导致「改完 A 又破 B」反复返工。现在全部收敛到本组件，外部只传原始输入。
 *
 * 选中视觉的四个独立维度（folder 选中是"容器状态"，与 video 行选中不同维度）：
 *   1. 整行底色 bg-accent/12
 *   2. 顶部 2px 实色 accent 横条（folder 独有通道）
 *   3. 左侧 accent 竖条
 *   4. 文件夹名前的 ✓ K/N 实底徽标
 * folder 名保持 secondary，与 video 行 text-accent 文件名区分，避免被误读成
 * 「这个 folder 本身被选中」。
 */
export function FolderHeader({
  folderId,
  folder,
  videos,
  expanded,
  focused,
  isVideoSelected,
  toggleVideoSelection,
  toggleFolderExpanded
}: FolderHeaderProps) {
  const groupSelected = videos.length > 0 && videos.every((v) => isVideoSelected(v.id))
  const groupPartial = !groupSelected && videos.some((v) => isVideoSelected(v.id))

  // 点左侧 2px 竖条：整组全选 / 取消全选。逐视频 toggle，复用选中层的
  // toggleVideoSelection（shift/ctrl 都传 false = 单纯加/去掉这一行）。
  const toggleGroup = () => {
    const target = !groupSelected
    videos.forEach((v) => {
      if (target !== isVideoSelected(v.id)) toggleVideoSelection(v.id, false, false)
    })
  }

  const displayName = folderId === -1 ? '未分类' : (folder?.name ?? `文件夹 #${folderId}`)

  const headerBg = groupSelected || groupPartial
    ? 'bg-accent/12'
    : focused
      ? 'bg-row-focus'
      : 'bg-row-group hover:bg-row-hover'
  const headerBorder = groupSelected || groupPartial ? 'border-t-2 border-accent' : ''

  return (
    <tr
      key={`folder-header-${folderId}`}
      onMouseDown={blockModifierTextSelection}
      className={`border-t border-line/40 ${headerBorder}`}
    >
      <td colSpan={2} className={`relative px-3 py-2 transition-colors ${headerBg}`}>
        {/* 左侧 2px 竖条：选中态（全选 + 部分）一律走 accent 满色，与 video 行
            左侧 accent 竖条对齐。仅光标无选中时走 disabled 灰条。 */}
        {groupSelected || groupPartial ? (
          <span className="absolute inset-y-0 left-0 w-[2px] bg-accent" />
        ) : focused ? (
          <span className="absolute inset-y-0 left-0 w-[2px] bg-disabled/60" />
        ) : null}
        <div className="flex items-center gap-2 text-[12px] font-medium text-secondary">
          {/* 全选该组：点竖条。热区做到 12px 宽（视觉仍是 2px），否则点不中。 */}
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
                groupSelected || groupPartial ? 'bg-accent' : 'bg-transparent'
              }`}
            />
          </span>
          {/* 展开/收起：整块（竖条右侧到视频数）都可点。文件夹名维持 secondary，
              故意与选中 video 行的 text-accent 区分，避免被误读成「folder 本身选中」。 */}
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
            {/* 选中徽标紧贴文件夹名右侧，不挤到行末 —— 视觉重心 = 文件夹名 + 徽标，
                与 video 行 text-accent 文件名对等权重。 */}
            {(groupSelected || groupPartial) && (
              <span
                className="shrink-0 rounded-md bg-accent px-2 py-0.5 text-[12px] font-bold leading-none tabular-nums text-ink-950"
                title={
                  groupSelected
                    ? '该目录下所有视频已选中'
                    : `该目录下有 ${videos.filter((v) => isVideoSelected(v.id)).length}/${videos.length} 个视频被选中`
                }
              >
                {groupSelected
                  ? `✓ ${videos.length}`
                  : `✓ ${videos.filter((v) => isVideoSelected(v.id)).length}/${videos.length}`}
              </span>
            )}
            <span
              className={`truncate ${
                groupSelected
                  ? 'rounded-md bg-accent/25 px-2 py-0.5 font-bold text-accent-strong ring-1 ring-accent/40'
                  : groupPartial
                    ? 'font-medium text-accent'
                    : 'font-medium'
              }`}
            >
              {displayName}
            </span>
            <span className="ml-auto shrink-0 text-[11px] font-normal text-muted">
              {videos.length} 个视频
            </span>
          </span>
        </div>
      </td>
      {/* 空的采样格：与数据行的采样列对齐，跟随 headerBg 让整行底色一致 */}
      <td className={headerBg} />
      {/* 空的操作格：让吸附列的左侧分隔线在标题行也连续；sticky right-0 保持吸附语义 */}
      <td className={`sticky right-0 w-[210px] border-l border-line/70 ${headerBg}`} />
    </tr>
  )
}
