import type { IndexerStatus, MediaToolsStatus } from '@shared/types'
import type { ImportProgressEvent } from '../lib/importProgress'

interface Props {
  status: IndexerStatus | null
  busy: string | null
  mediaTools?: MediaToolsStatus | null
  failedVideos?: number
  loadError?: string | null
  onRetryLoad?: () => void
  onConfigureMediaTools?: () => void
  onViewFailedVideos?: () => void
  /** 批量导入进度：扫描阶段 total 为 0，显示已发现文件数 */
  importProgress?: ImportProgressEvent | null
}

export function StatusBar({ status, busy, mediaTools, failedVideos = 0, loadError, onRetryLoad, onConfigureMediaTools, onViewFailedVideos, importProgress }: Props) {
  const running = status?.running ?? false
  const toolsMissing = mediaTools?.ready === false
  const total = status?.total ?? 0
  const done = (status?.done ?? 0) + (status?.failed ?? 0)
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0

  return (
    <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-line bg-surface-1 px-4 text-[10.5px] text-tertiary">
      <span className={`flex items-center gap-1.5 ${loadError || toolsMissing || failedVideos > 0 ? 'text-warn' : running ? 'text-accent' : 'text-tertiary'}`}>
        <span
          className={`h-1.5 w-1.5 rounded-full ${loadError || toolsMissing || failedVideos > 0 ? 'bg-warn' : running ? 'animate-pulse bg-accent' : 'bg-disabled'}`}
        />
        {running ? '正在索引' : loadError || toolsMissing || failedVideos > 0 ? '需要处理' : '就绪'}
      </span>

      {loadError && <button className="max-w-[42ch] truncate text-bad underline hover:text-primary" title={loadError} onClick={onRetryLoad}>{loadError} · 重试</button>}

      {toolsMissing && (
        <button className="shrink-0 text-warn underline hover:text-primary" onClick={onConfigureMediaTools} title={mediaTools?.message}>
          FFmpeg 未配置 · 设置目录
        </button>
      )}

      {failedVideos > 0 && (
        <button className="shrink-0 text-bad underline hover:text-primary" onClick={onViewFailedVideos}>
          {failedVideos} 个视频索引失败 · 查看
        </button>
      )}

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
          最近错误：{status.lastError}
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
