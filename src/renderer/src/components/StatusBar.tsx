import type { IndexerStatus } from '@shared/types'
import type { ImportProgressEvent } from '../lib/importProgress'

interface Props {
  status: IndexerStatus | null
  busy: string | null
  /** 批量导入进度：扫描阶段 total 为 0，显示已发现文件数 */
  importProgress?: ImportProgressEvent | null
}

export function StatusBar({ status, busy, importProgress }: Props) {
  const running = status?.running ?? false
  const total = status?.total ?? 0
  const done = (status?.done ?? 0) + (status?.failed ?? 0)
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0

  return (
    <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-line bg-surface-1 px-4 text-[10.5px] text-tertiary">
      <span className={`flex items-center gap-1.5 ${running ? 'text-accent' : 'text-tertiary'}`}>
        <span
          className={`h-1.5 w-1.5 rounded-full ${running ? 'animate-pulse bg-accent' : 'bg-disabled'}`}
        />
        {running ? '正在索引' : '就绪'}
      </span>

      {running && (
        <>
          <div className="h-1 w-32 overflow-hidden rounded-full bg-surface-4">
            <div
              className="h-full rounded-full bg-gradient-to-r from-accent to-accent-strong transition-all"
              style={{ width: `${percent}%` }}
            />
          </div>
          <span>{done}/{total}</span>
        </>
      )}

      {status?.currentPath && (
        <span className="max-w-[38ch] truncate text-secondary" title={status.currentPath}>
          {status.currentPath}
        </span>
      )}

      {status?.lastError && (
        <span className="max-w-[32ch] truncate text-bad" title={status.lastError}>
          {status.lastError}
        </span>
      )}

      <span className="ml-auto flex min-w-0 items-center gap-2">
        {busy && <span className="shrink-0 text-accent">{busy}</span>}
        {importProgress && (
          <span className="truncate text-secondary">
            {importProgress.total > 0
              ? `${importProgress.processed}/${importProgress.total}`
              : `已发现 ${importProgress.processed} 个文件`}
            {importProgress.added > 0 ? ` · 新增 ${importProgress.added}` : ''}
          </span>
        )}
      </span>
    </footer>
  )
}
