import { useState, type ReactNode } from 'react'

interface Props {
  /** 「+ 添加」等主操作，监听页显示 */
  onAddFolder: () => void
  /** 监听文件夹列表 */
  folders: ReactNode
  /** 是否处于拖拽高亮（拖文件夹进来时） */
  folderDrop: boolean
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
  /** 索引设置面板 */
  settings: ReactNode
  /** 监听目录数量，用于标签上的计数 */
  folderCount: number
}

/**
 * 视频库页右侧单栏（监听 / 设置 切换）。
 *
 * 此前 App 与 LibraryView 各有一层固定右面板（索引设置 300px + 监听 360px
 * = 660px），1280 宽窗口下表格只剩 620px、960 宽时几乎不可用。现合并为
 * 单栏 280px，两块内容按需切换，不再同时占位。
 */
export function SidePanel({
  onAddFolder,
  folders,
  folderDrop,
  onDragOver,
  onDragLeave,
  onDrop,
  settings,
  folderCount
}: Props) {
  const [tab, setTab] = useState<'folders' | 'settings'>('folders')

  return (
    <aside className="flex w-[280px] min-w-[240px] shrink-0 flex-col border-l border-line/70 bg-ink-900/40">
      <div className="flex shrink-0 gap-1 border-b border-line/70 p-2">
        <Tab active={tab === 'folders'} onClick={() => setTab('folders')} count={folderCount}>
          监听
        </Tab>
        <Tab active={tab === 'settings'} onClick={() => setTab('settings')}>
          索引设置
        </Tab>
      </div>

      {tab === 'folders' ? (
        <>
          <div className="flex shrink-0 items-center justify-between border-b border-line/70 px-3.5 py-2.5">
            <span className="text-[12.5px] font-semibold text-primary">监听文件夹</span>
            <button className="btn px-2 py-1 text-[11.5px] hover:bg-ink-700/70" onClick={onAddFolder}>
              + 添加
            </button>
          </div>

          <div
            className={`min-h-0 flex-1 overflow-y-auto p-2.5 ${folderDrop ? 'bg-accent/5' : ''}`}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            {folders}
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">{settings}</div>
      )}
    </aside>
  )
}

function Tab({
  active,
  onClick,
  count,
  children
}: {
  active: boolean
  onClick: () => void
  count?: number
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] transition ${
        active
          ? 'bg-ink-700/70 font-medium text-primary'
          : 'text-muted hover:bg-ink-800/50 hover:text-secondary'
      }`}
    >
      {children}
      {count !== undefined && (
        <span
          className={`rounded px-1 text-[10px] ${active ? 'bg-accent/20 text-accent' : 'bg-ink-700/60 text-tertiary'}`}
        >
          {count}
        </span>
      )}
    </button>
  )
}
