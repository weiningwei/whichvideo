import { errorMessage } from '../lib/errors'
import { useCallback, useEffect, useState } from 'react'
import type { MediaToolsStatus } from '@shared/types'
import { useModalFocus } from '../hooks/useModalFocus'

interface Props {
  status: MediaToolsStatus | null
  onSelect: () => void
  onRefresh: () => Promise<void>
  onOpenDownload: () => Promise<void>
}

const instructions = {
  Windows: '下载 Windows 可执行文件并解压，再选择同时包含 ffmpeg.exe 和 ffprobe.exe 的 bin 目录。',
  macOS: '可通过包管理器安装 FFmpeg，安装后点击重新检测；若未被检测到，再选择包含两个工具的目录。',
  Linux: '通过发行版包管理器安装 FFmpeg，安装后点击重新检测；若未被检测到，再选择包含两个工具的目录。',
} as const
type Platform = keyof typeof instructions

function currentPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'Windows'
  if (/Mac/i.test(navigator.userAgent)) return 'macOS'
  if (/Linux/i.test(navigator.userAgent)) return 'Linux'
  return 'Windows'
}

export function MediaToolsSetup({ status, onSelect, onRefresh, onOpenDownload }: Props) {
  const [dismissed, setDismissed] = useState(false)
  const [platform, setPlatform] = useState<Platform>(currentPlatform)
  const [refreshing, setRefreshing] = useState(false)
  const [openError, setOpenError] = useState('')
  const open = Boolean(status && !status.ready && !dismissed)
  const dismiss = useCallback(() => setDismissed(true), [])
  const dialogRef = useModalFocus<HTMLDivElement>(open, dismiss)

  useEffect(() => {
    if (status?.ready) setDismissed(false)
  }, [status?.ready])

  if (!open || !status) return null

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-surface-0/80 px-5 backdrop-blur-sm">
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="ffmpeg-title" className="w-full max-w-[500px] rounded-2xl border border-line bg-surface-1 p-5 shadow-2xl">
        <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-warn">需要外部工具</div>
        <h2 id="ffmpeg-title" className="text-[18px] font-semibold text-primary">设置 FFmpeg</h2>
        <p className="mt-2 text-[12px] leading-6 text-secondary">
          导入和搜索视频需要 FFmpeg。请先安装 FFmpeg，再选择同时包含
          <span className="mx-1 font-mono text-primary">ffmpeg</span>和
          <span className="mx-1 font-mono text-primary">ffprobe</span>的目录（Windows 文件名以 .exe 结尾）。
        </p>
        <div className="mt-3 flex gap-1" role="tablist" aria-label="安装平台">
          {(Object.keys(instructions) as Platform[]).map((name) => (
            <button key={name} role="tab" aria-selected={platform === name} className={`btn px-3 py-1 ${platform === name ? 'border-accent text-accent' : ''}`} onClick={() => setPlatform(name)}>{name}</button>
          ))}
        </div>
        <p className="mt-2 text-[12px] leading-5 text-secondary">{instructions[platform]}</p>
        <button className="mt-2 text-[12px] text-accent hover:underline" onClick={() => void onOpenDownload().catch((error: unknown) => setOpenError(errorMessage(error)))}>打开 FFmpeg 官方下载页 ↗</button>
        {openError && <p role="alert" className="mt-1 text-[11px] text-warn">无法打开下载页：{openError}</p>}
        <div className="mt-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[11px] leading-5 text-secondary">
          {status.message}
          <div className="mt-1 text-tertiary">如果已安装，也可以加入系统 PATH，然后点击重新检测。</div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn" onClick={() => setDismissed(true)}>稍后设置</button>
          <button className="btn" disabled={refreshing} onClick={() => { setRefreshing(true); void onRefresh().finally(() => setRefreshing(false)) }}>{refreshing ? '检测中…' : '重新检测'}</button>
          <button className="btn border-accent bg-accent text-surface-0 hover:bg-accent-strong" onClick={onSelect}>选择 bin 目录</button>
        </div>
      </div>
    </div>
  )
}
