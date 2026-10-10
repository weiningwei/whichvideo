/**
 * 索引帧图片存储：把抽帧时已经在 JS 内存里的 raw rgb24 像素编码成 JPEG 落盘。
 *
 * 数据目录布局：`<dataDir>/frames/<videoId>/<frameIndex>.jpg`
 * （帧图与库数据同目录，清空数据目录即全部带走；文件名用 frameIndex，
 * 与 frames 表的 frame_index 一一对应，查看时按 manifest 的 hasFile 懒取。）
 *
 * 编码走 Electron 自带的 nativeImage（rgb24→BGRA→JPEG），不引入新依赖、
 * 不改 scan.ts 的 ffmpeg 命令 —— seek 路径的 concat 单流 + passthrough 是
 * 全仓最脆弱处，绝不为了第二输出去碰它。
 *
 * 所有写/删失败只记日志、不抛错：帧图是附属品，索引与查看不能因它失败。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nativeImage } from 'electron'
import { log, logError } from './logger'

let framesRoot: string | null = null

/** bootstrap 时注入数据目录（logger.relocateLogger 同款模式） */
export function initializeFramesStore(dataDir: string): void {
  framesRoot = join(dataDir, 'frames')
}

function framePath(videoId: number, frameIndex: number): string | null {
  if (!framesRoot) return null
  return join(framesRoot, String(videoId), `${frameIndex}.jpg`)
}

/** nativeImage.createFromBitmap 要求 BGRA 排列，raw rgb24 需逐像素换序 */
function rgb24ToBgra(rgb: Buffer, width: number, height: number): Buffer {
  const pixelCount = width * height
  const out = Buffer.allocUnsafe(pixelCount * 4)
  for (let i = 0, j = 0; i < pixelCount; i++, j += 4) {
    const p = i * 3
    out[j] = rgb[p + 2] // B
    out[j + 1] = rgb[p + 1] // G
    out[j + 2] = rgb[p] // R
    out[j + 3] = 0xff // A
  }
  return out
}

/**
 * 保存单帧图像。失败返回 false 并记日志（不抛错，不阻断索引）。
 * rgb 必须恰为 width*height*3 字节（scan.ts 两条路径都满足）。
 */
export function saveFrameImage(
  videoId: number,
  frameIndex: number,
  rgb: Buffer,
  width: number,
  height: number
): boolean {
  const path = framePath(videoId, frameIndex)
  if (!path) return false
  // 边界校验：rgb 与声明尺寸不符时 BGRA 换序会静默产出花屏（Buffer 越界读
  // 不抛错），宁可不存也不能存坏图。
  if (rgb.length !== width * height * 3) {
    logError(
      `保存帧图失败：rgb 长度 ${rgb.length} != ${width}x${height}x3（video=${videoId} frame=${frameIndex}）`,
      new Error('帧图像素长度与声明尺寸不符')
    )
    return false
  }
  try {
    if (!existsSync(join(framesRoot!, String(videoId)))) {
      mkdirSync(join(framesRoot!, String(videoId)), { recursive: true })
    }
    const bitmap = rgb24ToBgra(rgb, width, height)
    const image = nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 })
    writeFileSync(path, image.toJPEG(85))
    return true
  } catch (err) {
    logError(`保存帧图失败：video=${videoId} frame=${frameIndex}`, err)
    return false
  }
}

export function frameImageExists(videoId: number, frameIndex: number): boolean {
  const path = framePath(videoId, frameIndex)
  return !!path && existsSync(path)
}

/** 读单帧图，返回 dataUrl；未保存/未初始化时返回 null */
export function readFrameImage(videoId: number, frameIndex: number): string | null {
  const path = framePath(videoId, frameIndex)
  if (!path || !existsSync(path)) return null
  try {
    return `data:image/jpeg;base64,${readFileSync(path).toString('base64')}`
  } catch (err) {
    logError(`读取帧图失败：video=${videoId} frame=${frameIndex}`, err)
    return null
  }
}

/** 删除单个视频的帧图目录（视频移除 / 重新索引前调用）。目录不存在时静默 */
export function removeVideoFrames(videoId: number): void {
  if (!framesRoot) return
  const dir = join(framesRoot, String(videoId))
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    logError(`删除帧图目录失败：${dir}`, err)
  }
}

/** 删除全部帧图（开关关闭时调用）。返回是否实际删除了内容 */
export function removeAllFrames(): boolean {
  if (!framesRoot || !existsSync(framesRoot)) return false
  try {
    rmSync(framesRoot, { recursive: true, force: true })
    log('已清空全部帧图文件')
    return true
  } catch (err) {
    logError('清空帧图目录失败', err)
    return false
  }
}
