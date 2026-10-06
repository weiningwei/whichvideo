import { useEffect, useState } from 'react'
import { useLibrary } from './hooks/useLibrary'
import { useTheme } from './hooks/useTheme'
import { Header } from './components/Header'
import { StatusBar } from './components/StatusBar'
import { ShortcutHelp } from './components/ShortcutHelp'
import { SearchView } from './components/SearchView'
import { LibraryView } from './components/LibraryView'
import { SettingsPanel } from './components/SettingsPanel'

export default function App() {
  const [tab, setTab] = useState<'search' | 'library'>('search')
  const { state, videoQuery, actions, runSearch, clearSearch, dismissNotice } = useLibrary()
  const { hasIndexedFrames, groupByFolder, selectedVideoIds, expandedFolderIds } = state
  const { reSearch, toggleGroupByFolder, toggleVideoSelection, clearSelection, selectAll,
    toggleFolderExpanded, expandAllFolders, collapseAllFolders, isVideoSelected, isFolderExpanded } = actions
  // 主题：深色 / 浅色 / 跟随系统。落在 <html data-theme> 上，CSS 侧自动换色值
  const { mode: themeMode, resolved: themeResolved, cycle: cycleTheme } = useTheme()

  const [helpOpen, setHelpOpen] = useState(false)

  // 全局快捷键：帮助面板、页签切换、刷新。
  // 列表内的导航与操作键在 LibraryView 里处理（那边才有焦点/选中状态）。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 输入框里不抢键，否则打不出 ? / 数字
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // 帮助面板开着时，除了 Esc（面板自己处理）之外都不响应
      if (helpOpen) return

      switch (e.key) {
        case '?':
        case '/':
          // '/' 归 LibraryView（聚焦筛选框），这里只处理 '?'
          if (e.key === '?') {
            e.preventDefault()
            setHelpOpen(true)
          }
          break
        case '1':
          e.preventDefault()
          setTab('search')
          break
        case '2':
          e.preventDefault()
          setTab('library')
          break
        case 'F5':
          // dev 下不拦：让 Vite 的 HMR 正常处理刷新，避免与插件打架
          if (!import.meta.env?.DEV) {
            e.preventDefault()
            window.location.reload()
          }
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [helpOpen])

  return (
    <div className="relative flex h-full flex-col">
      <Header
        stats={state.stats}
        status={state.status}
        tab={tab}
        onTab={setTab}
        busy={state.busy}
        onImportFiles={() => {
          void actions.importFiles()
          setTab('library')
        }}
        onImportFolder={() => {
          void actions.importFolder()
          setTab('library')
        }}
        themeMode={themeMode}
        themeResolved={themeResolved}
        onCycleTheme={cycleTheme}
        onShowShortcuts={() => setHelpOpen(true)}
      />

      <main className="flex min-h-0 flex-1 flex-col">
        {tab === 'search' ? (
          <SearchView
            search={state.search}
            searching={state.searching}
            error={state.searchError}
            queryImage={state.queryImage}
            queryLabel={state.queryLabel}
            hasIndexedFrames={hasIndexedFrames}
            onReSearch={reSearch}
            roots={state.folders.map((f) => f.path)}
            onPickImageFile={() => window.whichvideo.videos.importImages()}
            onSearchPath={(path) => void runSearch({ path })}
            onSearchDataUrl={(dataUrl, label) =>
              void runSearch({ dataUrl, label, dataUrlPreview: dataUrl })
            }
            onSearchClipboard={() => void runSearch({})}
            onSearchUrl={(url) => void runSearch({ url })}
            onClear={clearSearch}
            onOpen={(id, atSeconds) => void actions.openVideo(id, atSeconds)}
            onReveal={(id) => void actions.revealVideo(id)}
            onReindex={(id) => void actions.reindex([id])}
          />
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1">
            <LibraryView
              folders={state.folders}
              videos={state.videos}
              total={state.total}
              query={videoQuery}
              onSetQuery={actions.setVideoQuery}
              onAddFolder={() => void actions.importFolder()}
              onAddFolderPath={(p) => void actions.addFolderPath(p)}
              onImportFiles={() => {
                void actions.importFiles()
                setTab('library')
              }}
              onRemoveFolder={(id) => void actions.removeFolder(id)}
              onRescan={(id) => void actions.rescan(id)}
              onToggleFolder={(id, enabled) => void actions.toggleFolder(id, enabled)}
              onOpen={(id, atSeconds) => void actions.openVideo(id, atSeconds)}
              onReveal={(id) => void actions.revealVideo(id)}
              onRemoveVideo={(id) => void actions.removeVideo(id)}
              onRemoveVideos={(ids) => void actions.removeVideos(ids)}
              onReindex={(ids) => void actions.reindex(ids)}
              onFindDuplicates={(minScore) => actions.findDuplicates(minScore)}
              groupByFolder={groupByFolder}
              onToggleGroupByFolder={toggleGroupByFolder}
              selectedVideoIds={selectedVideoIds}
              expandedFolderIds={expandedFolderIds}
              isVideoSelected={isVideoSelected}
              isFolderExpanded={isFolderExpanded}
              toggleVideoSelection={toggleVideoSelection}
              clearSelection={clearSelection}
              selectAll={selectAll}
              toggleFolderExpanded={toggleFolderExpanded}
              expandAllFolders={expandAllFolders}
              collapseAllFolders={collapseAllFolders}
              sideSettings={
                <SettingsPanel
                  settings={state.settings}
                  dataDir={state.dataDir}
                  onChange={(patch) => void actions.updateSettings(patch)}
                  onReset={() => void actions.resetLibrary()}
                  onOpenDatabaseFolder={() => void actions.openDatabaseFolder()}
                />
              }
            />
          </div>
        )}
      </main>

      <StatusBar status={state.status} busy={state.busy} notice={state.notices[0] ?? null} />

      {state.notices.length > 1 && (
        <div className="pointer-events-auto absolute bottom-12 right-4 flex w-[360px] flex-col gap-2">
          {state.notices.slice(1, 4).map((notice) => (
            <button
              key={notice.id}
              onClick={() => dismissNotice(notice.id)}
              className={`rounded-xl border px-3 py-2 text-left text-[11.5px] shadow-lg backdrop-blur ${
                notice.level === 'error'
                  ? 'border-bad/50 bg-bad/15 text-bad'
                  : notice.level === 'warn'
                    ? 'border-warn/50 bg-warn/15 text-warn'
                    : 'border-line bg-ink-850/90 text-slate-300'
              }`}
            >
              {notice.message}
            </button>
          ))}
        </div>
      )}

      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} inLibrary={tab === 'library'} />
    </div>
  )
}
