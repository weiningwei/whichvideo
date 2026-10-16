import { useState } from 'react'
import type {
  DuplicatePair,
  SamplingMode,
  VideoQuery,
  VideoRecord
} from '@shared/types'

interface ToolbarProps {
  query: VideoQuery
  onSetQuery: (query: VideoQuery) => void
  videos: VideoRecord[]
  total: number
  selectedVideoIds: Set<number>
  /** 左侧文件夹树是否可见（G 键同效） */
  treeVisible: boolean
  onToggleTree: () => void
  /** 库内查重：返回相似对。耗时长（每视频一次全帧扫描），由按钮显式触发 */
  onFindDuplicates: (minScore?: number) => Promise<DuplicatePair[]>
  /** 查重完成后把结果交给父组件（父组件持有 duplicates 状态供弹层使用） */
  onDuplicatesResolved: (pairs: DuplicatePair[]) => void
  onReindex: (videoIds?: number[], mode?: SamplingMode) => void
  onRescan: (folderId?: number) => void
  onRemoveVideos: (videoIds: number[]) => void
  clearSelection: () => void
  filterInputRef: React.RefObject<HTMLInputElement | null>
}

/**
 * 库视图的工具条：左侧筛选区（关键字/目录/状态/排序 + 计数），右侧按钮区
 * （选中态操作 + 分组切换 + 查重 + 重建/重扫）。拆成独立组件，LibraryView 只做
 * 拼接。扫描态 scanningDuplicates 随工具条走（只有查重按钮用它）。
 */
export function Toolbar({
  query,
  onSetQuery,
  videos,
  total,
  selectedVideoIds,
  treeVisible,
  onToggleTree,
  onFindDuplicates,
  onDuplicatesResolved,
  onReindex,
  onRescan,
  onRemoveVideos,
  clearSelection,
  filterInputRef
}: ToolbarProps) {
  // 查重进行中标记（耗时较长，按钮禁用避免重复触发）
  const [scanningDuplicates, setScanningDuplicates] = useState(false)

  return (
    // 工具条分两层：左侧筛选区（内容多了自己换行），右侧按钮区独立 shrink-0。
    // 此前是单行 flex-wrap + ml-auto，选中时「已选 N」一出现就把整个按钮组
    // 挤到第二行（用户反馈：选中视频后三个按钮下移）。拆开后按钮永不换行，
    // 计数再用 invisible 常驻占位 —— 选中前后工具条布局零变化。
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
          title="↑/↓ 移动焦点 · Enter 打开 · Space 选中 · Ctrl+A 全选 · Esc 取消 · G 切换文件夹树"
        >
          ↑↓ 移动 · Enter 打开
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {selectedVideoIds.size > 0 && (
          <>
            <button
              className="btn text-[12px] hover:bg-ink-700/70"
              onClick={() => onReindex([...selectedVideoIds])}
              title="按全局采样模式把选中的视频重新排入索引队列"
            >
              重建索引（{selectedVideoIds.size}）
            </button>
            <button
              className="btn btn-danger text-[12px] hover:bg-bad/10"
              onClick={() => {
                const ids = [...selectedVideoIds]
                if (!window.confirm(`从索引库移除选中的 ${ids.length} 个视频？\n（不会删除磁盘文件，可随时重新导入）`)) return
                onRemoveVideos(ids)
                clearSelection()
              }}
              title="从索引库移除选中的视频（不删磁盘文件）"
            >
              移除（{selectedVideoIds.size}）
            </button>
          </>
        )}
        <button
          className={`btn text-[12px] hover:bg-ink-700/70 ${treeVisible ? 'bg-accent/20 border-accent/40' : ''}`}
          onClick={onToggleTree}
          title="显示/隐藏左侧文件夹树 (G)"
        >
          {treeVisible ? '🗂 树' : '🗂 显示树'}
        </button>
        <button
          className="btn text-[12px] hover:bg-ink-700/70"
          onClick={() => {
            if (scanningDuplicates) return
            setScanningDuplicates(true)
            void onFindDuplicates()
              .then((pairs) => onDuplicatesResolved(pairs))
              .finally(() => setScanningDuplicates(false))
          }}
          disabled={scanningDuplicates}
          title="找出库内画面高度相似的视频对（代表帧互搜，库越大越慢）"
        >
          {scanningDuplicates ? '查重中…' : '查重'}
        </button>
        <button className="btn text-[12px] hover:bg-ink-700/70" onClick={() => onReindex()}>
          重建全部索引
        </button>
        <button className="btn text-[12px] hover:bg-ink-700/70" onClick={() => onRescan()}>
          重新扫描目录
        </button>
      </div>
    </div>
  )
}
