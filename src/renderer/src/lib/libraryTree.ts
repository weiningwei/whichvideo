import type { VideoRecord, WatchedFolder } from '@shared/types'

/**
 * 左侧文件夹树（参照资源管理器导航窗格）的纯数据层。
 *
 * 以每个被监听目录（WatchedFolder）为根，按视频 `dir` 相对根的路径段建树。
 * 与「按文件夹分组」不同：树是任意深度的目录层级，节点可单独选中（= 该目录
 * 下的全部视频），与监听目录的「文件夹」概念解耦 —— 一个监听目录里可以有很多
 * 层子目录，树把它们都展开。
 *
 * 全部为纯函数，可单测；不依赖 React 或桌面后端。
 */

export interface DirNode {
  /** 稳定唯一 id：`f<folderId>` 为根，`d<绝对路径>` 为子目录 */
  id: string
  /** 最后一段目录名（用于显示） */
  name: string
  /** 绝对目录路径（Windows 反斜杠，已归一化） */
  path: string
  /** 层级：根为 0，每深一层 +1 */
  depth: number
  /** 父节点 id（根为 null） */
  parentId: string | null
  /** 子目录节点（按名称排序） */
  children: DirNode[]
  /** 该目录下的视频数（递归统计，含所有子目录） */
  videoCount: number
  /** 所属监听目录 id（根节点的 folderId） */
  folderId: number | null
}

/** 归一化目录路径：统一成 Windows 反斜杠、去掉尾部斜杠 */
export function normalizeDirPath(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '')
}

/**
 * 由监听目录与视频列表构建目录树。
 *
 * 每个视频按其 `folderId` 归属到监听目录，再按 `dir` 相对监听根的路径段插树。
 * 同一目录路径只建一个节点（`nodeByPath` 去重），多视频共享同一条路径链。
 */
export function buildFolderTree(folders: WatchedFolder[], videos: VideoRecord[]): DirNode[] {
  const roots: DirNode[] = []
  const nodeByPath = new Map<string, DirNode>()

  for (const folder of folders) {
    const rootPath = normalizeDirPath(folder.path)
    let root = nodeByPath.get(rootPath)
    if (!root) {
      root = {
        id: `f${folder.id}`,
        name: folder.name,
        path: rootPath,
        depth: 0,
        parentId: null,
        children: [],
        videoCount: 0,
        folderId: folder.id
      }
      nodeByPath.set(rootPath, root)
      roots.push(root)
    }
    const folderVideos = videos.filter((v) => v.folderId === folder.id)
    for (const v of folderVideos) {
      // 根递归计数：每有一个视频就给根 +1（整库该目录总数）
      root.videoCount++
      const dir = normalizeDirPath(v.dir)
      if (dir === rootPath) continue
      const rel = dir.slice(rootPath.length).replace(/^[\\/]/, '')
      if (!rel) continue
      const segs = rel.split(/[\\/]/)
      let cur = root
      let curPath = rootPath
      for (let i = 0; i < segs.length; i++) {
        curPath = curPath + '\\' + segs[i]
        let child = nodeByPath.get(curPath)
        if (!child) {
          child = {
            id: `d${curPath}`,
            name: segs[i],
            path: curPath,
            depth: i + 1,
            parentId: cur.id,
            children: [],
            videoCount: 0,
            folderId: folder.id
          }
          nodeByPath.set(curPath, child)
          cur.children.push(child)
        }
        child.videoCount++
        cur = child
      }
    }
  }

  // 子节点按名称稳定排序，避免每次重排跳动
  const sortRec = (nodes: DirNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    for (const n of nodes) sortRec(n.children)
  }
  sortRec(roots)
  return roots
}

/** 从一组 DirNode 根里按 path 找到对应节点（含递归） */
export function findDirNode(nodes: DirNode[], path: string): DirNode | null {
  const target = normalizeDirPath(path)
  const walk = (list: DirNode[]): DirNode | null => {
    for (const n of list) {
      if (n.path === target) return n
      const found = walk(n.children)
      if (found) return found
    }
    return null
  }
  return walk(nodes)
}

/**
 * 过滤出落在某目录下的视频。
 *
 * @param dir null = 全部（不过滤）
 * @param recursive true = 含所有子目录；false = 仅该目录直接子项
 *
 * 视频库语境下默认递归（用户选一个顶层目录，自然想看里面所有视频，
 * 而不是被空文件夹卡住）。`dir` 为 null 时返回原数组（不复制引用语义上等价）。
 */
export function videosUnderDir(videos: VideoRecord[], dir: string | null, recursive: boolean): VideoRecord[] {
  if (dir === null) return videos
  const target = normalizeDirPath(dir)
  return videos.filter((v) => {
    const vd = normalizeDirPath(v.dir)
    if (recursive) return vd === target || vd.startsWith(target + '\\')
    return vd === target
  })
}

/** 把绝对路径拆成面包屑段（用于地址栏）。根监听目录之前不拆。 */
export function pathSegments(path: string, roots: DirNode[]): { name: string; path: string }[] {
  const norm = normalizeDirPath(path)
  // 找到所属根，只展示根之后的相对段
  const root = roots.find((r) => norm === r.path || norm.startsWith(r.path + '\\'))
  if (!root) return [{ name: norm, path: norm }]
  const segs: { name: string; path: string }[] = [{ name: root.name, path: root.path }]
  if (norm === root.path) return segs
  const rel = norm.slice(root.path.length).replace(/^[\\/]/, '')
  const parts = rel.split(/[\\/]/)
  let acc = root.path
  for (const p of parts) {
    acc = acc + '\\' + p
    segs.push({ name: p, path: acc })
  }
  return segs
}
