import type { WhichVideoApi, VideoPage, VideoQuery } from '@shared/types'

/** 一次取齐首页所需数据；任一调用失败时由调用方保留旧快照并显示错误。 */
export async function loadLibrarySnapshot(api: WhichVideoApi) {
  const [stats, status, folders, settings, dataDir, mediaTools] = await Promise.all([
    api.library.stats(),
    api.library.status(),
    api.folders.list(),
    api.library.settings(),
    api.library.dataDir(),
    api.library.mediaTools()
  ])
  return { stats, status, folders, settings, dataDir, mediaTools }
}

/** 分页拉取完整视频列表；新查询到来时停止继续拉旧查询。 */
export async function loadVideoPages(
  list: WhichVideoApi['videos']['list'],
  query: VideoQuery,
  isCurrent: () => boolean
): Promise<VideoPage | null> {
  const limit = 500
  const first = await list({ ...query, offset: 0, limit })
  const items = [...first.items]
  while (items.length < first.total && isCurrent()) {
    const next = await list({ ...query, offset: items.length, limit })
    if (next.items.length === 0) break
    items.push(...next.items)
  }
  return isCurrent() ? { items, total: first.total } : null
}
