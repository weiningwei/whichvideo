import { type ReactNode } from 'react'
import { useModalFocus } from '../hooks/useModalFocus'

interface Props {
  mode: 'folders' | 'settings' | null
  onClose: () => void
  onAddFolder: () => void
  folders: ReactNode
  folderDrop: boolean
  settings: ReactNode
  folderCount: number
}

/** 低频管理项按需从右侧滑出，不再永久挤占视频列表。 */
export function SidePanel({
  mode, onClose, onAddFolder, folders, folderDrop, settings, folderCount
}: Props) {
  const dialogRef = useModalFocus<HTMLElement>(mode !== null, onClose)

  if (!mode) return null
  const foldersMode = mode === 'folders'
  return (
    <div className="absolute inset-0 z-30 bg-surface-0/45" onMouseDown={onClose}>
      <aside
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={foldersMode ? '管理文件夹' : '索引设置'}
        className="absolute inset-y-0 right-0 flex w-[360px] max-w-[85vw] flex-col border-l border-line bg-surface-2 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex h-14 shrink-0 items-center border-b border-line px-4">
          <div>
            <div className="text-[14px] font-semibold text-primary">{foldersMode ? '管理文件夹' : '索引设置'}</div>
            {foldersMode && <div className="text-[10.5px] text-tertiary">{folderCount} 个目录</div>}
          </div>
          {foldersMode && <button className="btn ml-auto py-1.5 text-[12px]" onClick={onAddFolder}>＋ 监视文件夹</button>}
          <button className="icon-btn ml-1" onClick={onClose} aria-label="关闭面板">×</button>
        </header>
        {foldersMode ? (
          <div
            className={`min-h-0 flex-1 overflow-y-auto p-3 ${folderDrop ? 'bg-accent/10' : ''}`}
          >
            {folders}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">{settings}</div>
        )}
      </aside>
    </div>
  )
}
