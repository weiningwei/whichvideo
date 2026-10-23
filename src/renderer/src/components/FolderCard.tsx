import type { WatchedFolder } from '@shared/types'
import { useConfirm } from './ConfirmDialog'

export const FOLDER_STATE_STYLE: Record<string, { text: string; cls: string }> = {
  watching: { text: '监听中', cls: 'border-ok/40 bg-ok/10 text-ok' },
  idle: { text: '已暂停', cls: 'border-line bg-ink-700/40 text-secondary' },
  missing: { text: '目录不存在', cls: 'border-bad/40 bg-bad/10 text-bad' },
  error: { text: '监听异常', cls: 'border-bad/40 bg-bad/10 text-bad' }
}

/** 资源树节点标识：描边文件夹避免被误读成复选框或半选状态。 */
export function FolderIcon() {
  return (
    <svg
      data-folder-icon
      className="h-4 w-4 shrink-0 text-accent"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.75 5.5h5l1.7 2H17.25v7.25a1.5 1.5 0 0 1-1.5 1.5h-11.5a1.5 1.5 0 0 1-1.5-1.5V5.5Z" />
      <path d="M2.75 7.5h14.5" />
    </svg>
  )
}

export function FolderCard({
  folder,
  onRemove,
  onRescan,
  onToggle,
  scanning
}: {
  folder: WatchedFolder
  onRemove: (id: number) => void
  onRescan: (id?: number) => void
  onToggle: (id: number, enabled: boolean) => void
  scanning: boolean
}) {
  const confirm = useConfirm()
  const style = FOLDER_STATE_STYLE[folder.watchState] ?? FOLDER_STATE_STYLE.idle
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
        <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] ${folder.pinned ? style.cls : 'border-line bg-surface-2 text-secondary'}`}>
          {folder.pinned ? style.text : '一次性导入'}
        </span>
      </div>

      {folder.message && (
        <div className="mt-1.5 truncate text-[10.5px] text-bad" title={folder.message}>
          {folder.message}
        </div>
      )}

      <div className="mt-2 flex items-center gap-1">
        {folder.pinned && <button
          className="btn px-2 py-1 text-[11px]"
          onClick={() => onToggle(folder.id, !folder.enabled)}
        >
          {folder.enabled ? '暂停监听' : '恢复监听'}
        </button>}
        <button className="btn px-2 py-1 text-[11px]" disabled={scanning} onClick={() => onRescan(folder.id)}>
          {scanning ? '扫描中…' : '扫描'}
        </button>
        <button
          className="ml-auto rounded-lg px-2 py-1 text-[11px] text-bad hover:bg-bad/10"
          onClick={async () => {
            if (await confirm({ title: '移除文件夹', message: `从视频库移除「${folder.name}」？\n仅移除未被其他导入目录覆盖的视频，不会删除磁盘文件。`, confirmLabel: '从库中移除', danger: true })) onRemove(folder.id)
          }}
          title="从索引库移除目录及未被其他导入目录覆盖的视频，不删除磁盘文件"
        >
          从库中移除
        </button>
      </div>
    </div>
  )
}
