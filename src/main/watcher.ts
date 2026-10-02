/**
 * 文件夹动态监听：目录里新增/覆盖/删除视频文件时，索引自动跟进。
 *
 * 使用 chokidar（Electron 主进程里动态 import，因为它只发布 ESM）。
 * 为避免 WebView/Electron 打包路径问题，watcher 只监听磁盘目录。
 */
import { existsSync, statSync } from 'node:fs'
import { normalizePath, pathKeyOf, type LibraryEvent, type WatchedFolder } from '@shared/types'
import type { LibraryDatabase } from './db'
import type { Indexer } from './indexer'

type Emit = (event: LibraryEvent) => void

interface WatchEntry {
  folderId: number
  path: string
  recursive: boolean
  watcher: { close: () => Promise<void> }
  ready: boolean
  watchedFiles: number
}

interface ChokidarModule {
  watch: (
    paths: string,
    options: Record<string, unknown>
  ) => {
    on: (event: string, cb: (...args: unknown[]) => void) => unknown
    close: () => Promise<void>
    unwatch: (paths: string | string[]) => Promise<void>
  }
}

let chokidarModule: ChokidarModule | null = null

async function loadChokidar(): Promise<ChokidarModule> {
  if (!chokidarModule) {
    chokidarModule = (await import('chokidar')) as unknown as ChokidarModule
  }
  return chokidarModule
}

export class FolderWatcher {
  private entries = new Map<number, WatchEntry>()
  private starting = false

  constructor(
    private readonly db: LibraryDatabase,
    private readonly indexer: Indexer,
    private readonly emit: Emit,
    private readonly awaitWriteMs: () => number
  ) {}

  get activeCount(): number {
    return [...this.entries.values()].filter((e) => e.ready).length
  }

  /** 按数据库中的文件夹配置重建全部监听 */
  async syncAll(): Promise<void> {
    if (this.starting) return
    this.starting = true
    try {
      const folders = this.db.listFolders()
      const wanted = new Set(folders.filter((f) => f.enabled).map((f) => f.id))

      for (const [id, entry] of [...this.entries]) {
        if (!wanted.has(id)) {
          await this.stop(id)
          void entry
        }
      }

      for (const folder of folders) {
        if (!folder.enabled) {
          this.db.updateFolderState(folder.id, 'idle', '已暂停监听')
          this.emitFolder(folder.id)
          continue
        }
        const existing = this.entries.get(folder.id)
        if (existing && existing.path === folder.path && existing.recursive === folder.recursive) continue
        if (existing) await this.stop(folder.id)
        await this.start(folder)
      }

      // 清理掉已经没有视频、也不是用户手动添加的目录记录
      const pruned = this.db.pruneEmptyFolders()
      if (pruned > 0) {
        this.emit({ type: 'stats', stats: this.db.stats() })
      }
    } finally {
      this.starting = false
    }
  }

  private async start(folder: WatchedFolder): Promise<void> {
    if (!existsSync(folder.path)) {
      this.db.updateFolderState(folder.id, 'missing', '目录不存在')
      this.emitFolder(folder.id)
      return
    }
    let chokidar: ChokidarModule
    try {
      chokidar = await loadChokidar()
    } catch (err) {
      this.db.updateFolderState(
        folder.id,
        'error',
        `无法加载文件监听模块：${err instanceof Error ? err.message : String(err)}`
      )
      this.emitFolder(folder.id)
      return
    }

    const watcher = chokidar.watch(folder.path, {
      persistent: true,
      ignoreInitial: true,
      depth: folder.recursive ? 32 : 0,
      awaitWriteFinish: {
        stabilityThreshold: this.awaitWriteMs(),
        pollInterval: 300
      },
      ignorePermissionErrors: true,
      followSymlinks: false
    })

    const entry: WatchEntry = { folderId: folder.id, path: folder.path, recursive: folder.recursive, watcher, ready: false, watchedFiles: 0 }
    this.entries.set(folder.id, entry)

    watcher.on('ready', () => {
      entry.ready = true
      this.db.updateFolderState(folder.id, 'watching', null)
      this.emitFolder(folder.id)
    })
    watcher.on('add', (...args: unknown[]) => {
      const filePath = String(args[0])
      this.handleUpsert(filePath)
    })
    watcher.on('change', (...args: unknown[]) => {
      const filePath = String(args[0])
      if (!isVideo(filePath)) return
      this.handleUpsert(filePath)
    })
    watcher.on('unlink', (...args: unknown[]) => {
      const filePath = String(args[0])
      if (!isVideo(filePath)) return
      this.indexer.onFileRemoved(normalizePath(filePath))
      this.emit({ type: 'notice', level: 'info', message: `文件已移除：${filePath}` })
    })
    watcher.on('unlinkDir', (...args: unknown[]) => {
      const dir = String(args[0])
      this.handleDirRemoved(dir)
    })
    watcher.on('error', (...args: unknown[]) => {
      const err = args[0]
      this.db.updateFolderState(folder.id, 'error', err instanceof Error ? err.message : String(err))
      this.emitFolder(folder.id)
    })

    this.db.updateFolderState(folder.id, 'watching', null)
    this.emitFolder(folder.id)
  }

  private handleUpsert(filePath: string): void {
    if (!isVideo(filePath)) return
    const normalized = normalizePath(filePath)
    try {
      if (!statSync(normalized).isFile()) return
    } catch {
      return
    }
    const folderId = this.folderForPath(normalized)
    this.indexer.onFileUpsert(normalized, folderId)
    this.emit({ type: 'notice', level: 'info', message: `发现新视频，已加入索引队列：${normalized}` })
  }

  private handleDirRemoved(dir: string): void {
    const normalized = normalizePath(dir)
    this.indexer.onDirectoryRemoved(normalized)
  }

  /** 找到包含该文件的、层级最深的被监听目录 */
  private folderForPath(filePath: string): number | null {
    const key = pathKeyOf(filePath)
    let best: { id: number; length: number } | null = null
    for (const entry of this.entries.values()) {
      const rootKey = pathKeyOf(entry.path)
      if (key === rootKey || key.startsWith(rootKey + '\\')) {
        if (!best || rootKey.length > best.length) best = { id: entry.folderId, length: rootKey.length }
      }
    }
    if (best) return best.id
    const folder = this.db.listFolders().find((f) => {
      const rootKey = pathKeyOf(f.path)
      return key.startsWith(rootKey + '\\')
    })
    return folder?.id ?? null
  }

  async stop(folderId: number): Promise<void> {
    const entry = this.entries.get(folderId)
    if (!entry) return
    this.entries.delete(folderId)
    try {
      await entry.watcher.close()
    } catch {
      /* 关闭失败不影响后续 */
    }
  }

  async stopAll(): Promise<void> {
    const ids = [...this.entries.keys()]
    for (const id of ids) await this.stop(id)
  }

  private emitFolder(folderId: number): void {
    const folder = this.db.getFolder(folderId)
    if (folder) this.emit({ type: 'folder-updated', folder })
  }

  /** 供 UI 展示：每个被监听目录当前统计 */
  snapshot(): { folderId: number; watching: boolean; recursive: boolean }[] {
    return [...this.entries.values()].map((e) => ({
      folderId: e.folderId,
      watching: e.ready,
      recursive: e.recursive
    }))
  }
}

function isVideo(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.')
  if (dot < 0) return false
  const ext = filePath.slice(dot).toLowerCase()
  return [
    '.mp4',
    '.mkv',
    '.avi',
    '.mov',
    '.wmv',
    '.flv',
    '.webm',
    '.m4v',
    '.mpg',
    '.mpeg',
    '.ts',
    '.m2ts',
    '.rmvb',
    '.rm',
    '.3gp'
  ].includes(ext)
}
