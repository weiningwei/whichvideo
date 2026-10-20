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
 * 背景：此前索引完成时后端广播的 `video-updated` 事件没有任何人消费
 * （useLibraryCore 的该分支是空的，videos state 又只在本 hook 里），
 * 于是新视频索引完了，列表还停在导入时的快照：状态「索引中」、帧数 0，
 * 直到手动切换查询或重开窗口才恢复。
 *
 * 规则：
 * - `video-updated`：行在列表里就**整条替换**（status / frameCount 随之刷新）。
 * - `video-updated` 且行不在列表里：只有能确定插入位置时才插入（见
 *   {@link canInsertNewRow}）。导入一个几千个视频的目录时，逐条插入让用户在
 *   扫描过程中就能看到视频进库，而不是等命令返回后一次性刷出来；其余视图
 *   （筛选、按名称/大小排序、指定目录）插入位置不确定，留给导入结束后的刷新。
 * - 过滤视图下，若当前查询只看某状态、而这条已变成别的状态（如正看着
 *   「索引中」过滤、这条完成了）→ 从视图移除，而不是以旧状态赖着。
 * - `video-removed`：直接移除。后端移除单条后只广播这一条事件，
 *   不删的话列表会留一行"库里没了、界面还在"的僵尸行。
 * - 其余事件类型与列表无关，原样返回。
 */

/** 新行只有在「不筛选 + 按最近添加排序」的视图里才有确定的插入位置。 */
export function canInsertNewRow(query: VideoQuery): boolean {
  if (query.keyword?.trim()) return false
  if (query.status && query.status !== 'all') return false
  if (query.folderId != null) return false
  return query.sort == null || query.sort === 'added'
}

function insertByAddedAt(prev: VideoRecord[], video: VideoRecord, ascending: boolean): VideoRecord[] {
  // 升序（最早在前）直接追加；降序插到第一个更早的行之前。时间相同保持原有
  // 顺序，避免同一批导入的视频在列表里反复换位。
  const at = ascending ? prev.length : prev.findIndex((item) => item.addedAt < video.addedAt)
  const next = [...prev]
  next.splice(at < 0 ? prev.length : at, 0, video)
  return next
}

export function applyVideoEvent(
  prev: VideoRecord[],
  event: LibraryEvent,
  query: VideoQuery
): VideoRecord[] {
  if (event.type === 'video-updated') {
    const next = event.video
    const idx = prev.findIndex((v) => v.id === next.id)
    if (idx < 0) {
      return canInsertNewRow(query) ? insertByAddedAt(prev, next, query.order === 'asc') : prev
    }
    const updated = [...prev]
    if (query.status && query.status !== 'all' && query.status !== next.status) {
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

type VideoListEvent = Extract<LibraryEvent, { type: 'video-updated' | 'video-removed' }>

/** 同一批事件只遍历一次列表；同一视频以最后一条事件为准。 */
export function applyVideoEvents(prev: VideoRecord[], events: VideoListEvent[], query: VideoQuery): VideoRecord[] {
  const changes = new Map<number, VideoListEvent>()
  for (const event of events) {
    changes.set(event.type === 'video-updated' ? event.video.id : event.videoId, event)
  }
  if (changes.size === 0) return prev

  let changed = false
  const existing: VideoRecord[] = []
  for (const video of prev) {
    const event = changes.get(video.id)
    if (!event) {
      existing.push(video)
      continue
    }
    changes.delete(video.id)
    changed = true
    if (event.type === 'video-updated' &&
      (!query.status || query.status === 'all' || query.status === event.video.status)) {
      existing.push(event.video)
    }
  }

  if (!canInsertNewRow(query)) return changed ? existing : prev
  const fresh: VideoRecord[] = []
  for (const event of changes.values()) {
    if (event.type === 'video-updated') fresh.push(event.video)
  }
  if (fresh.length === 0) return changed ? existing : prev
  const ascending = query.order === 'asc'
  fresh.sort((a, b) => ascending ? a.addedAt - b.addedAt : b.addedAt - a.addedAt)
  const merged: VideoRecord[] = []
  let nextFresh = 0
  for (const video of existing) {
    while (nextFresh < fresh.length && (ascending
      ? fresh[nextFresh].addedAt < video.addedAt
      : fresh[nextFresh].addedAt > video.addedAt)) {
      merged.push(fresh[nextFresh++])
    }
    merged.push(video)
  }
  merged.push(...fresh.slice(nextFresh))
  return merged
}

export function useVideoList(): UseVideoListReturn {
  /**
   * 列表与总数放在同一个 state 里：插入/移除一行时总数要跟着变（工具栏显示
   * 「N 个视频」），拆成两个 setState 会在渲染之间短暂不一致，也没法在更新
   * 函数里安全地推导总数。
   */
  const [list, setList] = useState<{ items: VideoRecord[]; total: number }>({ items: [], total: 0 })
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
    // 文件夹视图需要完整目录内容；单页 500 条会让后面的目录和视频凭空消失。
    const limit = 500
    const first: VideoPage = await window.whichvideo.videos.list({ ...q, offset: 0, limit })
    const items = [...first.items]
    while (items.length < first.total && seq === seqRef.current) {
      const next: VideoPage = await window.whichvideo.videos.list({ ...q, offset: items.length, limit })
      if (next.items.length === 0) break
      items.push(...next.items)
    }
    if (seq !== seqRef.current) return
    setList({ items, total: first.total })
  }, [])

  const setVideoQuery = useCallback((next: VideoQuery) => {
    queryRef.current = next
    setVideoQueryState(next)
    void refreshVideos(next)
  }, [refreshVideos])

  useEffect(() => {
    void refreshVideos()
  }, [refreshVideos])

  /** 批量合并索引事件，最多约每 150ms 更新一次列表。 */
  useEffect(() => {
    let pending: VideoListEvent[] = []
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      timer = null
      const events = pending
      pending = []
      setList((prev) => {
        const items = applyVideoEvents(prev.items, events, queryRef.current)
        const total = Math.max(0, prev.total + items.length - prev.items.length)
        return items === prev.items && total === prev.total ? prev : { items, total }
      })
    }
    const unsubscribe = window.whichvideo.events.subscribe((event: LibraryEvent) => {
      if (event.type !== 'video-updated' && event.type !== 'video-removed') return
      pending.push(event)
      if (timer === null) timer = setTimeout(flush, 150)
    })
    return () => {
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
    }
  }, [])

  return {
    videos: list.items,
    total: list.total,
    videoQuery,
    refreshVideos,
    setVideoQuery
  }
}
