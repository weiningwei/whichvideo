import type { LibraryStats, IndexerStatus } from '@shared/types'
import type { ResolvedTheme, ThemeMode } from '../hooks/useTheme'

const THEME_ICON: Record<ThemeMode, string> = { dark: '◐', light: '◑', system: '◒' }
const THEME_LABEL: Record<ThemeMode, string> = { dark: '深色', light: '浅色', system: '跟随系统' }

interface Props {
  stats: LibraryStats
  status: IndexerStatus | null
  tab: 'search' | 'library'
  onTab: (tab: 'search' | 'library') => void
  busy: string | null
  themeMode: ThemeMode
  themeResolved: ResolvedTheme
  onCycleTheme: () => void
  onShowShortcuts: () => void
}

/** 全局栏只负责品牌、页面导航与全局状态；页面动作留在对应页面内。 */
export function Header({ stats, status, tab, onTab, busy, themeMode, themeResolved, onCycleTheme, onShowShortcuts }: Props) {
  const running = status?.running ?? false
  return (
    <header className="flex h-14 shrink-0 items-center border-b border-line bg-surface-1 px-4">
      <div className="flex items-center gap-2.5 pr-8">
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-accent text-[13px] font-bold text-surface-0">▶</span>
        <span className="text-[14px] font-semibold tracking-tight text-primary">WhichVideo</span>
      </div>
      <nav className="flex h-full items-center gap-1" aria-label="主导航">
        <NavButton active={tab === 'search'} onClick={() => onTab('search')}>搜图</NavButton>
        <NavButton active={tab === 'library'} onClick={() => onTab('library')}>视频库</NavButton>
      </nav>
      <div className="ml-auto flex items-center gap-1.5">
        {(running || busy) && (
          <span className="mr-2 flex items-center gap-2 text-[11.5px] text-secondary">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            {busy ?? `正在索引 ${status?.active ?? 0} 个视频`}
          </span>
        )}
        {!running && !busy && stats.videos > 0 && (
          <span className="mr-2 text-[11px] tabular-nums text-tertiary">{stats.videos} 个视频</span>
        )}
        <button
          className="icon-btn"
          onClick={onCycleTheme}
          title={`主题：${THEME_LABEL[themeMode]}${themeMode === 'system' ? `（当前${themeResolved === 'dark' ? '深色' : '浅色'}）` : ''}`}
          aria-label="切换主题"
        >
          {THEME_ICON[themeMode]}
        </button>
        <button className="icon-btn" onClick={onShowShortcuts} title="键盘快捷键 (?)" aria-label="键盘快捷键">?</button>
      </div>
    </header>
  )
}

function NavButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`relative h-full px-4 text-[13px] transition ${active ? 'font-medium text-primary' : 'text-tertiary hover:text-secondary'}`}
    >
      {children}
      {active && <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-accent" />}
    </button>
  )
}
