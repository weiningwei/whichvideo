import type { VideoQuery } from '@shared/types'

type SortKey = NonNullable<VideoQuery['sort']>

export function sortVideoQuery(query: VideoQuery, sort: SortKey, toggleCurrent = false): VideoQuery {
  const current = query.sort ?? 'added'
  const order = toggleCurrent && current === sort
    ? (query.order === 'asc' ? 'desc' : 'asc')
    : sort === 'name' ? 'asc' : 'desc'
  return { ...query, sort, order, offset: 0 }
}

export function reverseVideoSort(query: VideoQuery): VideoQuery {
  return { ...query, order: query.order === 'asc' ? 'desc' : 'asc', offset: 0 }
}
