import type { LibraryStats, IndexerStatus } from '@shared/types'
import type { ResolvedTheme, ThemeMode } from '../hooks/useTheme'
import { formatBytes } from '../lib/format'

/** 三档主题的按钮文案与图标。用几何字符而非 emoji，保证在所有字体下都渲染正常。 */
const THEME_ICON: Record<ThemeMode, string> = {
  dark: '◐',
  light: '◑',
  system: '◒'
}
const THEME_LABEL: Record<ThemeMode, string> = {
  dark: '深色',
  light: '浅色',
  system: '跟随系统'
}

interface Props {
  stats: LibraryStats
  status: IndexerStatus | null
  tab: 'search' | 'library'
  onTab: (tab: 'search' | 'library') => void
  onImportFiles: () => void
  onImportFolder: () => void
  busy: string | null
  /** 当前主题模式（dark / light / system） */
  themeMode: ThemeMode
  /** system 模式解析后的实际主题，仅用于提示文案 */
  themeResolved: ResolvedTheme
  onCycleTheme: () => void
}

export function Header({
  stats,
  status,
  tab,
  onTab,
  onImportFiles,
  onImportFolder,
  busy,
  themeMode,
  themeResolved,
  onCycleTheme
}: Props) {
  const running = status?.running ?? false
  return (
    <header className="flex items-center gap-4 border-b border-line/80 bg-ink-900/70 px-5 py-3 backdrop-blur">
      <div className="flex items-center gap-3">
        {/* 「WV」文字色刻意固定：它压在 accent 渐变方块上，深浅两套主题下都必须是深色。
            用语义 token 会跟着主题变，浅色主题下就变成浅字压浅底。
            这条例外记在 scripts/test-theme.mjs 的 HEX_EXCEPTIONS 里。 */}
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-accent to-accent-strong text-[15px] font-bold text-[#042C53]">
          WV
        </div>
        {/* 只留 tagline，不再重复产品名：WV 字母标已经是品牌标识，窗口标题栏与
            任务栏也都写着 WhichVideo，界内再写一遍是同一句话说三次。
            tagline 提为视觉主标识，说的却是产品做的事而非叫什么。 */}
        <div className="text-[13px] font-semibold leading-tight text-secondary">
          以图搜帧
          <span className="ml-1.5 text-[11px] font-normal text-muted">本地视频库</span>
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
        <button
          className="btn px-2 hover:bg-ink-700/70"
          onClick={onCycleTheme}
          title={`主题：${THEME_LABEL[themeMode]}${themeMode === 'system' ? `（当前${themeResolved === 'dark' ? '深色' : '浅色'}）` : ''} — 点击切换`}
          aria-label="切换主题"
        >
          {THEME_ICON[themeMode]}
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
        active ? 'bg-accent/20 text-accent shadow-inner' : 'text-secondary hover:bg-ink-700/60'
      }`}
    >
      {children}
    </button>
  )
}

function Metric({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-tertiary">{label}</span>
      <span className={`font-semibold ${highlight ? 'text-ok' : 'text-primary'}`}>{value}</span>
    </span>
  )
}
