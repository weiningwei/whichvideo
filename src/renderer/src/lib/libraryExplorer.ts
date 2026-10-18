import type { VideoRecord, WatchedFolder } from '@shared/types'

/** 统一分隔符并保留 Windows 盘符根目录。 */
export function normalizeDirPath(path: string): string {
  const normalized = path.replace(/\//g, '\\')
  if (/^[A-Za-z]:\\+$/.test(normalized)) return normalized.slice(0, 2) + '\\'
  return normalized.replace(/\\+$/, '')
}

export interface ExplorerNode {
  path: string
  name: string
  folder: WatchedFolder | null
  children: ExplorerNode[]
  videos: VideoRecord[]
  count: number
}

export type ExplorerRow =
  | { type: 'folder'; node: ExplorerNode; depth: number }
  | { type: 'video'; video: VideoRecord; depth: number }

function key(path: string): string { return normalizeDirPath(path).toLocaleLowerCase() }
function contains(root: string, dir: string): boolean {
  const a = key(root)
  const b = key(dir)
  return b === a || b.startsWith(a.endsWith('\\') ? a : a + '\\')
}
function nameOf(path: string): string {
  return normalizeDirPath(path).split(/[\\/]/).filter(Boolean).pop() || path
}

/** 将已登记的导入目录和旧数据中的未归属目录统一建为可展开的目录树。 */
export function buildExplorerTree(folders: WatchedFolder[], videos: VideoRecord[]): ExplorerNode[] {
  const roots: ExplorerNode[] = folders.map((folder) => ({
    path: normalizeDirPath(folder.path), name: folder.name, folder,
    children: [], videos: [], count: 0
  }))
  const byFolderId = new Map(folders.map((folder, i) => [folder.id, roots[i]]))
  const byPath = new Map(roots.map((root) => [key(root.path), root]))

  for (const video of videos) {
    const dir = normalizeDirPath(video.dir)
    let root = video.folderId == null ? undefined : byFolderId.get(video.folderId)
    if (!root || !contains(root.path, dir)) {
      root = roots.filter((candidate) => contains(candidate.path, dir))
        .sort((a, b) => b.path.length - a.path.length)[0]
    }
    if (!root) {
      root = byPath.get(key(dir))
      if (!root) {
        root = { path: dir, name: nameOf(dir), folder: null, children: [], videos: [], count: 0 }
        roots.push(root)
        byPath.set(key(dir), root)
      }
    }
    root.count++
    let node = root
    const relative = dir.slice(root.path.length).replace(/^[\\/]/, '')
    for (const part of relative ? relative.split(/[\\/]/).filter(Boolean) : []) {
      const path = node.path.replace(/[\\/]$/, '') + '\\' + part
      let child = node.children.find((item) => key(item.path) === key(path))
      if (!child) {
        child = { path, name: part, folder: null, children: [], videos: [], count: 0 }
        node.children.push(child)
      }
      child.count++
      node = child
    }
    node.videos.push(video)
  }
  const sort = (nodes: ExplorerNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    nodes.forEach((node) => sort(node.children))
  }
  sort(roots)
  return roots
}

export function visibleExplorerRows(roots: ExplorerNode[], expanded: Set<string>, revealAll = false, forcedClosed = new Set<string>()): ExplorerRow[] {
  const rows: ExplorerRow[] = []
  const visit = (node: ExplorerNode, depth: number) => {
    rows.push({ type: 'folder', node, depth })
    if (forcedClosed.has(key(node.path)) || (!revealAll && !expanded.has(key(node.path)))) return
    node.children.forEach((child) => visit(child, depth + 1))
    node.videos.forEach((video) => rows.push({ type: 'video', video, depth: depth + 1 }))
  }
  roots.forEach((root) => visit(root, 0))
  return rows
}

export function explorerPathKey(path: string): string { return key(path) }
