import type { LibraryStats, IndexerStatus } from '@shared/types'
import { formatBytes } from '../lib/format'

interface Props {
  stats: LibraryStats
  status: IndexerStatus | null
  tab: 'search' | 'library'
  onTab: (tab: 'search' | 'library') => void
  onImportFiles: () => void
  onImportFolder: () => void
  busy: string | null
}

export function Header({ stats, status, tab, onTab, onImportFiles, onImportFolder, busy }: Props) {
  const running = status?.running ?? false
  return (
    <header className="flex items-center gap-4 border-b border-line/80 bg-ink-900/70 px-5 py-3 backdrop-blur">
      <div className="flex items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-accent to-accent-strong text-[15px] font-bold text-ink-950">
          WV
        </div>
        <div className="leading-tight">
          <div className="text-[15px] font-semibold text-slate-100">WhichVideo</div>
          <div className="text-[11px] text-muted">以图搜帧 · 本地视频库</div>
        </div>
      </div>

      <div className="ml-2 flex items-center gap-1 rounded-xl border border-line/80 bg-ink-850/60 p-1">
        <TabButton active={tab === 'search'} onClick={() => onTab('search')}>
          图片搜索
        </TabButton>
        <TabButton active={tab === 'library'} onClick={() => onTab('library')}>
          视频库与监听
        </TabButton>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <div className="mr-2 hidden items-center gap-3 text-[11px] text-muted lg:flex">
          <Metric label="视频" value={String(stats.videos)} />
          <Metric label="已索引" value={String(stats.indexedVideos)} />
          <Metric label="帧指纹" value={stats.frames.toLocaleString('zh-CN')} />
          <Metric label="体积" value={formatBytes(stats.totalBytes)} />
          <Metric
            label="监听"
            value={`${stats.watching}/${stats.folders}`}
            highlight={stats.watching > 0}
          />
        </div>
        {running && (
          <span className="flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] text-accent">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            索引中 {status?.queued ? `队列 ${status.queued}` : ''}
          </span>
        )}
        <button className="btn hover:bg-ink-700/70" onClick={onImportFiles} disabled={!!busy}>
          + 导入视频
        </button>
        <button
          className="btn border-accent-strong/60 bg-accent/15 text-accent hover:bg-accent/25"
          onClick={onImportFolder}
          disabled={!!busy}
        >
          + 导入文件夹
        </button>
      </div>
    </header>
  )
}

function TabButton({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-[12.5px] transition ${
        active ? 'bg-accent/20 text-accent shadow-inner' : 'text-slate-300 hover:bg-ink-700/60'
      }`}
    >
      {children}
    </button>
  )
}

function Metric({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-slate-500">{label}</span>
      <span className={`font-semibold ${highlight ? 'text-ok' : 'text-slate-200'}`}>{value}</span>
    </span>
  )
}
