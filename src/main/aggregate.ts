/**
 * 视频级检索聚合：把「单个视频命中的多帧」合成一个视频分数。
 *
 * 传统做法是 best + secondBest（次佳帧可在视频内任意时间点）。但"任意时间点"会把
 * 散落在整片时间轴上、彼此无关的幸运命中也一并算进去——例如片头/片尾反复出现的
 * Logo、每隔几分钟复现一次的相似构图、两张截图撞上同一帧背景。时间一致性过滤是
 * CBCD（视频拷贝检测）的标准第二步：真命中通常是一段连续画面，邻近帧都相似，
 * 命中点聚在某个时间窗里；假命中则随机散落在整片时间轴。
 *
 * 这里把「无条件全局次佳」替换为「时间上贴近最佳帧的次强命中」：按与最佳帧的
 * 时间距离线性衰减（triangular kernel），超过窗口则完全不计。纯函数、无 IO、
 * 无 SQLite 状态，可独立测试。
 */

/** 一帧命中（score 已按结构/颜色加权，timeSeconds 为该帧在视频中的时间点） */
export interface FrameHit {
  score: number
  timeSeconds: number
}

/**
 * 时间一致性支持度：在命中帧集合（无需预排序）里，取「时间上最贴近最佳帧的
 * 次强命中」的衰减分。返回 0~1；只有一帧命中时为 0。
 *
 * 与「全局次佳」的区别：若次佳帧距离最佳帧超过 windowSeconds，则视为时间上
 * 不相关的偶然命中，衰减为 0，不再抬高视频分数。多条次强命中里取衰减后最大者，
 * 等价于"最可信的那一次佐证"。
 */
export function temporalSupport(hits: FrameHit[], windowSeconds: number): number {
  if (hits.length < 2) return 0

  let bestIndex = 0
  for (let i = 1; i < hits.length; i++) {
    if (hits[i].score > hits[bestIndex].score) bestIndex = i
  }
  const bestTime = hits[bestIndex].timeSeconds

  let support = 0
  for (let i = 0; i < hits.length; i++) {
    if (i === bestIndex) continue
    const dt = Math.abs(hits[i].timeSeconds - bestTime)
    const weight = Math.max(0, 1 - dt / windowSeconds)
    const decayed = hits[i].score * weight
    if (decayed > support) support = decayed
  }
  return support
}
