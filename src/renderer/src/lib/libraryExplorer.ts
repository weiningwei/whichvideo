import { normalizePath, pathKeyOf, type VideoRecord, type WatchedFolder } from '@shared/types'

/** 统一分隔符并保留 Windows 盘符根目录。 */
export function normalizeDirPath(path: string): string {
  return normalizePath(path)
}

export interface ExplorerNode {
  path: string
  name: string
  folder: WatchedFolder | null
  children: ExplorerNode[]
  videos: VideoRecord[]
  count: number
}

export interface ExplorerTree {
  folders: ExplorerNode[]
  looseVideos: VideoRecord[]
}

export type ExplorerRow =
  | { type: 'folder'; node: ExplorerNode; depth: number }
  | { type: 'video'; video: VideoRecord; depth: number }
  | { type: 'empty'; path: string; depth: number }

function key(path: string): string { return pathKeyOf(path) }
function contains(root: string, dir: string): boolean {
  const a = key(root)
  const b = key(dir)
  const separator = a.startsWith('/') ? '/' : '\\'
  return b === a || b.startsWith(a.endsWith(separator) ? a : a + separator)
}
/** 导入目录按实际路径嵌套；单独导入的视频仍留在顶层。 */
export function buildExplorerTree(folders: WatchedFolder[], videos: VideoRecord[]): ExplorerTree {
  const roots: ExplorerNode[] = []
  const byFolderId = new Map<number, ExplorerNode>()
  const allNodes = new Map<string, ExplorerNode>()
  const looseVideos: VideoRecord[] = []

  const ensurePath = (root: ExplorerNode, dir: string, video?: VideoRecord): void => {
    let node = root
    if (video) node.count++
    const relative = dir.slice(root.path.length).replace(/^[\\/]/, '')
    for (const part of relative ? relative.split(/[\\/]/).filter(Boolean) : []) {
      const separator = node.path.startsWith('/') ? '/' : '\\'
      const path = node.path.replace(/[\\/]$/, '') + separator + part
      let child = allNodes.get(key(path))
      if (!child) {
        child = { path, name: part, folder: null, children: [], videos: [], count: 0 }
        node.children.push(child)
        allNodes.set(key(path), child)
      }
      if (video) child.count++
      node = child
    }
    if (video) node.videos.push(video)
  }

  for (const folder of [...folders].sort((a, b) => a.path.length - b.path.length)) {
    const path = normalizeDirPath(folder.path)
    const parent = [...byFolderId.values()]
      .filter((node) => contains(node.path, path) && key(node.path) !== key(path))
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (parent) ensurePath(parent, path)
    let node = allNodes.get(key(path))
    if (!node) {
      node = { path, name: folder.name, folder: null, children: [], videos: [], count: 0 }
      roots.push(node)
      allNodes.set(key(path), node)
    }
    node.folder = folder
    byFolderId.set(folder.id, node)
  }

  for (const video of videos) {
    const dir = normalizeDirPath(video.dir)
    const root = video.folderId == null ? undefined : byFolderId.get(video.folderId)
    if (!root || !contains(root.path, dir)) {
      looseVideos.push(video)
      continue
    }
    // 视频归属子目录时，父级导入目录的计数也应包含它。
    const top = roots.find((node) => contains(node.path, root.path)) ?? root
    ensurePath(top, dir, video)
  }
  const sort = (nodes: ExplorerNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    nodes.forEach((node) => sort(node.children))
  }
  sort(roots)
  return { folders: roots, looseVideos }
}

export function visibleExplorerRows(tree: ExplorerTree, expanded: Set<string>, revealAll = false, forcedClosed = new Set<string>()): ExplorerRow[] {
  const rows: ExplorerRow[] = []
  const visit = (node: ExplorerNode, depth: number) => {
    rows.push({ type: 'folder', node, depth })
    if (forcedClosed.has(key(node.path)) || (!revealAll && !expanded.has(key(node.path)))) return
    node.children.forEach((child) => visit(child, depth + 1))
    node.videos.forEach((video) => rows.push({ type: 'video', video, depth: depth + 1 }))
    if (node.count === 0) rows.push({ type: 'empty', path: node.path, depth: depth + 1 })
  }
  tree.folders.forEach((root) => visit(root, 0))
  tree.looseVideos.forEach((video) => rows.push({ type: 'video', video, depth: 0 }))
  return rows
}

export function explorerPathKey(path: string): string { return key(path) }
