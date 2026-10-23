import { useEffect, useState } from 'react'
import { useLibrary } from './hooks/useLibrary'
import { useTheme } from './hooks/useTheme'
import { Header } from './components/Header'
import { StatusBar } from './components/StatusBar'
import { ShortcutHelp } from './components/ShortcutHelp'
import { SearchView } from './components/SearchView'
import { LibraryView } from './components/LibraryView'
import { SettingsPanel } from './components/SettingsPanel'
import { MediaToolsSetup } from './components/MediaToolsSetup'
import { NoticeStack } from './components/NoticeStack'

export default function App() {
  const [tab, setTab] = useState<'search' | 'library'>('search')
  const { state, videoQuery, actions, runSearch, clearSearch, refreshAll, dismissNotice, pauseNotice, resumeNotice } =
    useLibrary()
  const { hasIndexedFrames, treeVisible, selectedVideoIds } = state
  const { reSearch, toggleTreeVisible, toggleVideoSelection, clearSelection, setSelectionOrder,
    setSelectedIds, isVideoSelected } = actions
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
        tab={tab}
        onTab={setTab}
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
            libraryVideoCount={state.stats.videos}
            libraryIndexedVideoCount={state.stats.indexedVideos}
            libraryFailedVideoCount={state.stats.failedVideos}
            onOpenLibrary={() => setTab('library')}
            onReSearch={reSearch}
            onPickImageFile={() => window.whichvideo.videos.importImages()}
            onSearchPath={(path) => void runSearch({ path })}
            onSearchDataUrl={(dataUrl, label) =>
              void runSearch({ dataUrl, label, dataUrlPreview: dataUrl })
            }
            onSearchClipboard={() => void runSearch({})}
            onSearchUrl={(url) => runSearch({ url })}
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
              lastImportResult={state.lastImportResult}
              onRetryImportFailures={() => void actions.retryImportFailures()}
              busy={state.busy}
              importProgress={state.importProgress}
              indexStatus={state.status}
              query={videoQuery}
              onSetQuery={actions.setVideoQuery}
              onAddFolder={() => void actions.watchFolder()}
              onImportFolder={() => void actions.importFolderOnce()}
              onDropPaths={(paths, watchFolders) => void actions.importDroppedPaths(paths, watchFolders)}
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
              onRemoveVideos={(ids) => actions.removeVideos(ids)}
              onReindex={(ids, mode) => void actions.reindex(ids, mode)}
              globalSampling={state.settings?.samplingMode ?? 'uniform'}
              onFindDuplicates={(minScore) => actions.findDuplicates(minScore)}
              treeVisible={treeVisible}
              onToggleTree={toggleTreeVisible}
              selectedVideoIds={selectedVideoIds}
              isVideoSelected={isVideoSelected}
              toggleVideoSelection={toggleVideoSelection}
              clearSelection={clearSelection}
              setSelectedIds={setSelectedIds}
              setSelectionOrder={setSelectionOrder}
              sideSettings={
                <SettingsPanel
                  settings={state.settings}
                  dataDir={state.dataDir}
                  mediaTools={state.mediaTools}
                  onChange={(patch) => void actions.updateSettings(patch)}
                  onSelectMediaTools={() => void actions.selectMediaToolsDir()}
                  onRefreshMediaTools={() => void actions.refreshMediaTools()}
                  onClearMediaTools={() => void actions.clearMediaToolsDir()}
                  onReset={() => void actions.resetLibrary()}
                  onOpenDatabaseFolder={() => void actions.openDatabaseFolder()}
                  onExportDiagnostics={() => void actions.exportDiagnostics()}
                />
              }
            />
          </div>
        )}
      </main>

      {/* 状态栏展示持续任务和需要处理的问题；一次性反馈仍放在通知浮层。 */}
      <StatusBar
        status={state.status}
        busy={state.busy}
        mediaTools={state.mediaTools}
        failedVideos={state.stats.failedVideos}
        loadError={state.loadError}
        onRetryLoad={() => void refreshAll().catch(() => { /* 状态栏保留错误与重试入口 */ })}
        onConfigureMediaTools={() => void actions.selectMediaToolsDir()}
        onViewFailedVideos={() => {
          actions.setVideoQuery({ ...videoQuery, keyword: '', folderId: null, status: 'failed', offset: 0 })
          setTab('library')
        }}
        importProgress={state.importProgress}
      />

      <NoticeStack notices={state.notices} onDismiss={dismissNotice} onPause={pauseNotice} onResume={resumeNotice} />

      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} inLibrary={tab === 'library'} />
      <MediaToolsSetup status={state.mediaTools} onSelect={() => void actions.selectMediaToolsDir()} onRefresh={actions.refreshMediaTools} onOpenDownload={() => window.whichvideo.library.openFfmpegDownload()} />
    </div>
  )
}
