/**
 * 查重结果的分组聚合。
 *
 * 主进程返回的是两两 pair（AB、AC、BC…），A/B/C 三者相似时会出 3 对 ——
 * 用户面对"一堆配对"很乱。参考 dupeGuru 等重复文件工具的通用做法，
 * 把两两关系聚合成**相似组**（连通分量）：AB、BC 相似 → A/B/C 同组，
 * 用户在组内挑一个保留、其余移除，而不是逐对处理。
 *
 * 纯函数，便于行为测试。
 */
import type { DuplicatePair, VideoRecord } from '@shared/types'

export interface DuplicateGroup {
  /** 组 id = 组内最小 videoId（稳定） */
  id: string
  /** 组内全部成员，按体积降序（体积最大者默认作为保留建议） */
  members: VideoRecord[]
  /** 组内最高的 pair 相似度 */
  bestScore: number
  /** 组内任一 pair 是完全相同文件（SHA-256 一致） */
  identicalFile: boolean
  /** 默认保留建议：体积最大的成员 */
  suggestedKeepId: number
}

export function buildDuplicateGroups(pairs: DuplicatePair[]): DuplicateGroup[] {
  // 并查集
  const parent = new Map<number, number>()
  const find = (x: number): number => {
    const root = parent.get(x)
    if (root === undefined) {
      parent.set(x, x)
      return x
    }
    if (root === x) return x
    const top = find(root)
    parent.set(x, top)
    return top
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const p of pairs) {
    find(p.videoA.id)
    find(p.videoB.id)
    union(p.videoA.id, p.videoB.id)
  }

  // 组内成员与最佳分收集
  const members = new Map<number, { videos: Map<number, VideoRecord>; bestScore: number; identical: boolean }>()
  for (const p of pairs) {
    const root = find(p.videoA.id)
    let group = members.get(root)
    if (!group) {
      group = { videos: new Map(), bestScore: 0, identical: false }
      members.set(root, group)
    }
    group.videos.set(p.videoA.id, p.videoA)
    group.videos.set(p.videoB.id, p.videoB)
    group.bestScore = Math.max(group.bestScore, p.score)
    group.identical = group.identical || p.identicalFile
  }

  const groups: DuplicateGroup[] = []
  for (const group of members.values()) {
    // 排序稳定性：find 的根可能因路径压缩变化，用组内最小 videoId 做稳定 id
    const ids = [...group.videos.keys()]
    const id = String(Math.min(...ids))
    const sorted = [...group.videos.values()].sort((a, b) => b.size - a.size)
    groups.push({
      id,
      members: sorted,
      bestScore: group.bestScore,
      identicalFile: group.identical,
      suggestedKeepId: sorted[0]?.id ?? 0
    })
  }
  groups.sort((a, b) => b.bestScore - a.bestScore)
  return groups
}

/** 组内当前应保留的成员：用户指定优先，否则默认（体积最大） */
export function keptInGroup(group: DuplicateGroup, keptIds: ReadonlySet<number>): VideoRecord {
  return (
    group.members.find((m) => keptIds.has(m.id)) ??
    group.members.find((m) => m.id === group.suggestedKeepId) ??
    group.members[0]
  )
}
