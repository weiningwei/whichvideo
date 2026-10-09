/**
 * 抽帧采样策略：决定「抽多少帧、抽哪些时间点」。纯函数，无 ffmpeg / 文件 IO 依赖，
 * 与 media.ts（二进制查找 + 进程执行 + 抽帧）解耦，可独立测试。
 *
 * 帧数决策链：framesForDuration（时长 → 策略帧数）→ plannedFrameCount（与用户设置取小）。
 * 时间点两条来源：
 *   · planTimestamps —— 按时长均匀取每段中点（避开片头片尾黑场）
 *   · planSceneTimestamps —— 场景切换点优先 + 长镜头补帧（场景点由 media.ts::detectScenes 产出）
 * shouldUseFullScan 决定抽帧走逐点 seek 还是单次全片解码。
 */
import { DEFAULT_FRAME_BUDGET, FRAME_COUNT_TABLE, SEEK_VS_FULLSCAN_CROSSOVER } from './constants'

// 对外转出这两个策略常量：media.ts 作为门面再转出，test-frame-policy 依赖
export { DEFAULT_FRAME_BUDGET, SEEK_VS_FULLSCAN_CROSSOVER }

export function shouldUseFullScan(frameCount: number, width?: number | null, height?: number | null): boolean {
  // 4K 视频强制走全片解码：seek 模式对 4K 解码极慢
  const is4K = (width ?? 0) >= 3840 || (height ?? 0) >= 2160
  return is4K || frameCount > SEEK_VS_FULLSCAN_CROSSOVER
}

/** 按视频时长得出的建议抽帧数（未与用户设置取小） */
export function framesForDuration(durationSeconds: number | null): number {
  if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return FRAME_COUNT_TABLE[0][1]
  }
  const table = FRAME_COUNT_TABLE
  if (durationSeconds >= table[table.length - 1][0]) return table[table.length - 1][1]
  for (let i = 1; i < table.length; i++) {
    const [t1, f1] = table[i]
    if (durationSeconds > t1) continue
    const [t0, f0] = table[i - 1]
    const ratio = t1 === t0 ? 0 : (durationSeconds - t0) / (t1 - t0)
    const value = f0 + (f1 - f0) * ratio
    return Math.max(2, Math.round(value / 2) * 2)
  }
  return table[table.length - 1][1]
}

/**
 * 计划抽帧用的帧数：策略值与用户设置（作为上限）取小。
 * 用户把"每视频帧数"调大也不会超过时长策略，避免短视频被抽过多帧。
 */
export function plannedFrameCount(durationSeconds: number | null, budget: number): number {
  const policy = framesForDuration(durationSeconds)
  const cap = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : DEFAULT_FRAME_BUDGET
  return Math.max(1, Math.min(policy, cap))
}

/** 根据时长与帧数决定抽帧时间点（秒），取每段中点以避开片头片尾黑场 */
export function planTimestamps(duration: number | null, frameBudget: number): number[] {
  if (!duration || !Number.isFinite(duration) || duration <= 0.5) {
    return [0]
  }
  const count = plannedFrameCount(duration, frameBudget)
  if (count <= 1) return [duration / 2]

  const list: number[] = []
  for (let i = 0; i < count; i++) {
    const t = duration * ((i + 0.5) / count)
    list.push(Math.min(Math.max(t, 0.05), Math.max(duration - 0.05, 0.05)))
  }
  return list
}

/**
 * 场景采样计划：场景切换点优先 + 长镜头内部均匀补充，总数不超过 frameBudget。
 *
 * - 场景点 = 每个镜头的代表帧来源，**全部保留**（它们是"每个镜头至少一帧"
 *   的保证，也是本模式存在的意义）
 * - 相邻间隔超过 max(2×理想间隔, 8s) 的段视为长镜头，段内均匀补帧
 *   （idealGap = 时长/预算；8s 下限避免超长预算时无意义密采）
 * - 补充点总数超预算时均匀丢弃补充点（不动场景点）；预算有富余则不再增补
 * - 无场景切换（纯色/渐变视频）时退回均匀计划
 */
export function planSceneTimestamps(
  sceneTimes: number[],
  duration: number | null,
  frameBudget: number
): number[] {
  if (sceneTimes.length === 0) return planTimestamps(duration, frameBudget)
  const D = duration && Number.isFinite(duration) && duration > 0.5 ? duration : sceneTimes[sceneTimes.length - 1] + 5

  // 场景点：排序 + 去重（0.5s 内的密集切换视为同一处）
  const scenes: number[] = []
  for (const raw of sceneTimes) {
    const t = Math.min(Math.max(raw, 0.05), Math.max(D - 0.05, 0.05))
    if (scenes.length === 0 || t - scenes[scenes.length - 1] > 0.5) scenes.push(t)
  }

  const idealGap = D / Math.max(1, frameBudget)
  const minGap = Math.max(2 * idealGap, 8)

  // 长镜头内部补充点
  const fills: number[] = []
  for (let i = 0; i < scenes.length; i++) {
    const cur = scenes[i]
    const next = i + 1 < scenes.length ? scenes[i + 1] : Math.max(D, cur + 1)
    const gap = next - cur
    const extra = Math.floor(gap / minGap) - 1
    for (let k = 1; k <= extra; k++) fills.push(cur + (gap * k) / (extra + 1))
  }

  // 预算裁剪：只裁补充点（场景点全保留），均匀丢弃保持覆盖均匀
  const over = scenes.length + fills.length - frameBudget
  if (over > 0 && fills.length > 0) {
    const keepCount = Math.max(0, fills.length - over)
    const kept: number[] = []
    for (let k = 0; k < keepCount; k++) {
      // 等距保留补充点
      kept.push(fills[Math.round((k * fills.length) / keepCount)])
    }
    fills.length = 0
    fills.push(...kept)
  }

  return [...scenes, ...fills].sort((a, b) => a - b)
}
