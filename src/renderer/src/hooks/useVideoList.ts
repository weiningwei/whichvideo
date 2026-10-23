import { useCallback, useEffect, useRef, useState } from 'react'
import { type VideoQuery, type VideoRecord, type VideoPage, type LibraryEvent } from '@shared/types'

export interface UseVideoListReturn {
  videos: VideoRecord[]
  total: number
  videoQuery: VideoQuery
  refreshError: string | null
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

function compareAdded(a: VideoRecord, b: VideoRecord, ascending: boolean): number {
  const difference = a.addedAt - b.addedAt || a.id - b.id
  return ascending ? difference : -difference
}

function insertByAddedAt(prev: VideoRecord[], video: VideoRecord, ascending: boolean): VideoRecord[] {
  const at = prev.findIndex((item) => compareAdded(video, item, ascending) < 0)
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

/** 筛选或其它排序视图无法安全插入新行时，按需从数据库校正。 */
export function shouldRefreshForUnseenVideo(
  knownIds: Set<number>,
  event: VideoListEvent,
  query: VideoQuery
): boolean {
  if (event.type !== 'video-updated' || canInsertNewRow(query) || knownIds.has(event.video.id)) return false
  if (query.status && query.status !== 'all' && query.status !== event.video.status) return false
  if (query.folderId != null && query.folderId !== event.video.folderId) return false
  return true
}

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
  fresh.sort((a, b) => compareAdded(a, b, ascending))
  const merged: VideoRecord[] = []
  let nextFresh = 0
  for (const video of existing) {
    while (nextFresh < fresh.length && compareAdded(fresh[nextFresh], video, ascending) < 0) {
      merged.push(fresh[nextFresh++])
    }
    merged.push(video)
  }
  merged.push(...fresh.slice(nextFresh))
  return merged
}

/** 分页拉取期间到达的事件可能比查询快照新，落库结果必须重放这些变化。 */
export function reconcileFetchedPage(page: VideoPage, events: VideoListEvent[], query: VideoQuery): VideoPage {
  const items = applyVideoEvents(page.items, events, query)
  return { items, total: Math.max(0, page.total + items.length - page.items.length) }
}

export function useVideoList(): UseVideoListReturn {
  /**
   * 列表与总数放在同一个 state 里：插入/移除一行时总数要跟着变（工具栏显示
   * 「N 个视频」），拆成两个 setState 会在渲染之间短暂不一致，也没法在更新
   * 函数里安全地推导总数。
   */
  const [list, setList] = useState<{ items: VideoRecord[]; total: number }>({ items: [], total: 0 })
  const [videoQuery, setVideoQueryState] = useState<VideoQuery>({ limit: 500, status: 'all', sort: 'added' })
  const [refreshError, setRefreshError] = useState<string | null>(null)

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
  const eventRevisionRef = useRef(0)
  const eventLogRef = useRef<Array<{ revision: number; event: VideoListEvent }>>([])
  const activeFetchesRef = useRef(0)
  const knownIdsRef = useRef(new Set<number>())
  useEffect(() => {
    knownIdsRef.current = new Set(list.items.map((video) => video.id))
  }, [list.items])

  const refreshVideos = useCallback(async (query?: VideoQuery) => {
    const q = query ?? queryRef.current
    const seq = ++seqRef.current
    const startedAtRevision = eventRevisionRef.current
    activeFetchesRef.current++
    try {
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
      const events = eventLogRef.current
        .filter((entry) => entry.revision > startedAtRevision)
        .map((entry) => entry.event)
      setList(reconcileFetchedPage({ items, total: first.total }, events, q))
      setRefreshError(null)
    } catch (error) {
      if (seq === seqRef.current) setRefreshError(`视频列表加载失败：${error instanceof Error ? error.message : String(error)}`)
      throw error
    } finally {
      activeFetchesRef.current--
      if (activeFetchesRef.current === 0) eventLogRef.current = []
    }
  }, [])

  const setVideoQuery = useCallback((next: VideoQuery) => {
    queryRef.current = next
    setVideoQueryState(next)
    void refreshVideos(next).catch(() => { /* 错误由 refreshError 持续展示 */ })
  }, [refreshVideos])

  useEffect(() => {
    void refreshVideos().catch(() => { /* 错误由 refreshError 持续展示 */ })
  }, [refreshVideos])

  /** 批量合并索引事件，最多约每 150ms 更新一次列表。 */
  useEffect(() => {
    let alive = true
    let pending: VideoListEvent[] = []
    let timer: ReturnType<typeof setTimeout> | null = null
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    let refreshing = false
    let refreshAgain = false
    const scheduleRefresh = () => {
      if (!alive || refreshTimer !== null) return
      refreshTimer = setTimeout(async () => {
        refreshTimer = null
        if (refreshing) {
          refreshAgain = true
          return
        }
        refreshing = true
        try {
          await refreshVideos()
        } catch {
          // 下一条相关事件仍可重试；保留当前列表供用户继续操作。
        } finally {
          refreshing = false
          if (alive && refreshAgain) {
            refreshAgain = false
            scheduleRefresh()
          }
        }
      }, 500)
    }
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
      const revision = ++eventRevisionRef.current
      if (activeFetchesRef.current > 0) eventLogRef.current.push({ revision, event })
      if (shouldRefreshForUnseenVideo(knownIdsRef.current, event, queryRef.current)) scheduleRefresh()
      pending.push(event)
      if (timer === null) timer = setTimeout(flush, 150)
    })
    return () => {
      alive = false
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
      if (refreshTimer !== null) clearTimeout(refreshTimer)
    }
  }, [refreshVideos])

  return {
    videos: list.items,
    total: list.total,
    videoQuery,
    refreshError,
    refreshVideos,
    setVideoQuery
  }
}
