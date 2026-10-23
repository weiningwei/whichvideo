import { useEffect, useState } from 'react'
import type { FrameManifestEntry } from '@shared/types'

/**
 * 读取视频预览，并统一处理组件卸载/切换视频后的过期响应。
 * 指定时间点时优先现场解码，无结果时再回退到视频缩略图。
 */
export function useVideoPreview(videoId: number, refreshKey: number | null, atSeconds?: number): string | null {
  const [preview, setPreview] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setPreview(null)
    const load = async () => {
      try {
        let data: string | null = null
        if (atSeconds !== undefined) {
          try {
            data = await window.whichvideo.videos.matchFrame(videoId, Math.round(atSeconds * 1000))
          } catch {
            // 时间点解码失败仍尝试已有缩略图。
          }
        }
        if (!data && atSeconds !== undefined) data = await window.whichvideo.videos.thumbnail(videoId)
        if (atSeconds === undefined) data = await window.whichvideo.videos.thumbnail(videoId)
        if (active) setPreview(data)
      } catch {
        if (active) setPreview(null)
      }
    }
    void load()
    return () => { active = false }
  }, [videoId, refreshKey, atSeconds])

  return preview
}

/** 索引帧清单读取边界；切换视频时立即清空旧清单。 */
export function useFrameManifest(videoId: number | null) {
  const [manifest, setManifest] = useState<FrameManifestEntry[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    setManifest(null)
    setError(false)
    if (videoId === null) return
    let active = true
    void window.whichvideo.videos.frameManifest(videoId)
      .then((list) => { if (active) setManifest(list) })
      .catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [videoId])

  return { manifest, error }
}
