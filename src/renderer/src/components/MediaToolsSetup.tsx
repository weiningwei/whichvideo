import { useEffect, useState } from 'react'
import type { MediaToolsStatus } from '@shared/types'

interface Props {
  status: MediaToolsStatus | null
  onSelect: () => void
}

export function MediaToolsSetup({ status, onSelect }: Props) {
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (status?.ready) setDismissed(false)
  }, [status?.ready])

  if (!status || status.ready || dismissed) return null

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-surface-0/80 px-5 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-labelledby="ffmpeg-title" className="w-full max-w-[460px] rounded-2xl border border-line bg-surface-1 p-5 shadow-2xl">
        <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-warn">需要外部工具</div>
        <h2 id="ffmpeg-title" className="text-[18px] font-semibold text-primary">设置 FFmpeg</h2>
        <p className="mt-2 text-[12px] leading-6 text-secondary">
          WhichVideo 不再内置 FFmpeg。请先安装 FFmpeg，再选择同时包含
          <span className="mx-1 font-mono text-primary">ffmpeg.exe</span>和
          <span className="mx-1 font-mono text-primary">ffprobe.exe</span>的 bin 目录。
        </p>
        <div className="mt-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[11px] leading-5 text-secondary">
          {status.message}
          <div className="mt-1 text-tertiary">也可以配置系统 PATH，或设置 WHICHVIDEO_BIN_DIR。</div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn" onClick={() => setDismissed(true)}>稍后设置</button>
          <button className="btn border-accent bg-accent text-surface-0 hover:bg-accent-strong" onClick={onSelect}>选择 bin 目录</button>
        </div>
      </div>
    </div>
  )
}
