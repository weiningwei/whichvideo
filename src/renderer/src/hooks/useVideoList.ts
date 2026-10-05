import { useCallback, useEffect, useState } from 'react'
import { type VideoQuery, type VideoRecord, type VideoPage } from '@shared/types'

export interface UseVideoListReturn {
  videos: VideoRecord[]
  total: number
  videoQuery: VideoQuery
  refreshVideos: (query?: VideoQuery) => Promise<void>
  setVideoQuery: (query: VideoQuery) => void
}

export function useVideoList(): UseVideoListReturn {
  const [videos, setVideos] = useState<VideoRecord[]>([])
  const [total, setTotal] = useState(0)
  const [videoQuery, setVideoQueryState] = useState<VideoQuery>({ limit: 500, status: 'all', sort: 'added' })

  const refreshVideos = useCallback(async (query?: VideoQuery) => {
    const q = query ?? videoQuery
    const page: VideoPage = await window.whichvideo.videos.list(q)
    setVideos(page.items)
    setTotal(page.total)
  }, [videoQuery])

  const setVideoQuery = useCallback((next: VideoQuery) => {
    setVideoQueryState(next)
    void refreshVideos(next)
  }, [refreshVideos])

  useEffect(() => {
    void refreshVideos()
  }, [refreshVideos])

  return {
    videos,
    total,
    videoQuery,
    refreshVideos,
    setVideoQuery
  }
}