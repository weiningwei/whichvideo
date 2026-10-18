import { useCallback, useRef, useState } from 'react'
import { type SearchResponse } from '@shared/types'

export interface UseSearchReturn {
  search: SearchResponse | null
  searching: boolean
  searchError: string | null
  queryImage: string | null
  queryLabel: string | null
  runSearch: (input: SearchInput) => Promise<void>
  reSearch: () => Promise<void>
  clearSearch: () => void
}

export interface SearchInput {
  path?: string
  dataUrl?: string
  url?: string
  label?: string
  dataUrlPreview?: string
}

export function useSearch(): UseSearchReturn {
  const [search, setSearch] = useState<SearchResponse | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [queryImage, setQueryImage] = useState<string | null>(null)
  const [queryLabel, setQueryLabel] = useState<string | null>(null)
  const lastSearchInput = useRef<SearchInput | null>(null)
  const requestId = useRef(0)

  const runSearch = useCallback(async (input: SearchInput) => {
    const currentRequest = ++requestId.current
    lastSearchInput.current = input
    setSearching(true)
    setSearch(null)
    setSearchError(null)
    setQueryImage(null)
    setQueryLabel(input.label ?? input.path ?? input.url ?? null)
    // 四条输入路径的失败都以 error/errorCode 返回（而非抛异常），
    // 必须统一接住——否则文件/拖入/粘贴失败会静默变成"没有结果"。
    const applyResponse = (response: SearchResponse): void => {
      if (currentRequest !== requestId.current) return
      setSearch(response)
      if (response.error) setSearchError(response.error)
    }
    try {
      if (input.path) {
        const response = await window.whichvideo.search.byPath(input.path)
        if (currentRequest !== requestId.current) return
        applyResponse(response)
        setQueryImage(`file://${input.path}`)
        setQueryLabel(input.label ?? input.path)
      } else if (input.dataUrl) {
        const response = await window.whichvideo.search.byDataUrl(input.dataUrl)
        if (currentRequest !== requestId.current) return
        applyResponse(response)
        setQueryImage(input.dataUrlPreview ?? input.dataUrl)
        setQueryLabel(input.label ?? '图片')
      } else if (input.url) {
        const response = await window.whichvideo.search.byUrl(input.url)
        if (currentRequest !== requestId.current) return
        applyResponse(response)
        setQueryImage(null)
        setQueryLabel(response.queryImageUrl ?? input.label ?? input.url)
      } else {
        const clipboard = await window.whichvideo.search.byClipboard()
        if (currentRequest !== requestId.current) return
        if (!clipboard) {
          setSearchError('剪贴板里没有图片，请先复制一张图片再点这个按钮')
          return
        }
        setSearch(clipboard.response)
        setQueryImage(clipboard.dataUrl)
        setQueryLabel(input.label ?? '剪贴板图片')
      }
    } catch (err) {
      if (currentRequest === requestId.current) setSearchError(err instanceof Error ? err.message : String(err))
    } finally {
      if (currentRequest === requestId.current) setSearching(false)
    }
  }, [])

  const reSearch = useCallback(async () => {
    if (lastSearchInput.current) {
      await runSearch(lastSearchInput.current)
    }
  }, [runSearch])

  const clearSearch = useCallback(() => {
    requestId.current++
    setSearch(null)
    setSearchError(null)
    setQueryImage(null)
    setQueryLabel(null)
    lastSearchInput.current = null
    setSearching(false)
  }, [])

  return {
    search,
    searching,
    searchError,
    queryImage,
    queryLabel,
    runSearch,
    reSearch,
    clearSearch
  }
}
