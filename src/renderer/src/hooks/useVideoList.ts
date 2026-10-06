import { useCallback, useEffect, useRef, useState } from 'react'
import { type VideoQuery, type VideoRecord, type VideoPage, type LibraryEvent } from '@shared/types'

export interface UseVideoListReturn {
  videos: VideoRecord[]
  total: number
  videoQuery: VideoQuery
  refreshVideos: (query?: VideoQuery) => Promise<void>
  setVideoQuery: (query: VideoQuery) => void
}

/**
 * 把一条库事件应用到视频列表上，返回新列表（纯函数，便于行为测试）。
 *
 * 背景：此前索引完成时主进程广播的 `video-updated` 事件没有任何人消费
 * （useLibraryCore 的该分支是空的，videos state 又只在本 hook 里），
 * 于是新视频索引完了，列表还停在导入时的快照：状态「索引中」、帧数 0，
 * 直到手动切换查询或重开窗口才恢复。
 *
 * 规则：
 * - `video-updated`：行在列表里就**整条替换**（status / frameCount 随之刷新）；
 *   不在就返回原列表 —— 新增行由导入后的 `refreshAll` 负责，这里乱插入会
 *   破坏排序、也会绕过当前查询的过滤条件。
 * - 过滤视图下，若当前查询只看某状态、而这条已变成别的状态（如正看着
 *   「索引中」过滤、这条完成了）→ 从视图移除，而不是以旧状态赖着。
 * - `video-removed`：直接移除。主进程移除单条后只广播这一条事件，
 *   不删的话列表会留一行"库里没了、界面还在"的僵尸行。
 * - 其余事件类型与列表无关，原样返回。
 */
export function applyVideoEvent(
  prev: VideoRecord[],
  event: LibraryEvent,
  statusFilter: VideoQuery['status']
): VideoRecord[] {
  if (event.type === 'video-updated') {
    const next = event.video
    const idx = prev.findIndex((v) => v.id === next.id)
    if (idx < 0) return prev
    const updated = [...prev]
    if (statusFilter !== 'all' && statusFilter !== next.status) {
      updated.splice(idx, 1)
      return updated
    }
    updated[idx] = next
    return updated
  }
  if (event.type === 'video-removed') {
    return prev.filter((v) => v.id !== event.videoId)
  }
  return prev
}

export function useVideoList(): UseVideoListReturn {
  const [videos, setVideos] = useState<VideoRecord[]>([])
  const [total, setTotal] = useState(0)
  const [videoQuery, setVideoQueryState] = useState<VideoQuery>({ limit: 500, status: 'all', sort: 'added' })

  /**
   * 当前查询条件（过滤视图与拉取都用）。用 ref 而不是把 videoQuery 放进
   * effect/回调的依赖 —— 依赖一变就重订阅/重建回调，白折腾；ref 让
   * 回调永远读到最新的过滤条件。setVideoQuery 里会同步更新，不等渲染。
   */
  const queryRef = useRef(videoQuery)
  queryRef.current = videoQuery

  /**
   * 拉取序号：只有**最新一次**拉取允许写 state。
   *
   * 此前没有守卫：筛选框每击键发一次 list 请求，快速输入时先发的旧请求
   * 可能后返回，用过期关键词的结果覆盖新结果（列表内容与筛选框对不上、
   * 或闪回旧数据）。序号守卫让晚到的旧响应直接丢弃。
   */
  const seqRef = useRef(0)

  const refreshVideos = useCallback(async (query?: VideoQuery) => {
    const q = query ?? queryRef.current
    const seq = ++seqRef.current
    const page: VideoPage = await window.whichvideo.videos.list(q)
    if (seq !== seqRef.current) return
    setVideos(page.items)
    setTotal(page.total)
  }, [])

  const setVideoQuery = useCallback((next: VideoQuery) => {
    queryRef.current = next
    setVideoQueryState(next)
    void refreshVideos(next)
  }, [refreshVideos])

  useEffect(() => {
    void refreshVideos()
  }, [refreshVideos])

  /** 订阅索引事件并就地更新行；规则见 {@link applyVideoEvent}。 */
  useEffect(() => {
    const unsubscribe = window.whichvideo.events.subscribe((event: LibraryEvent) => {
      setVideos((prev) => applyVideoEvent(prev, event, queryRef.current.status))
    })
    return unsubscribe
  }, [])

  return {
    videos,
    total,
    videoQuery,
    refreshVideos,
    setVideoQuery
  }
}
