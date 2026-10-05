import { useCallback, useState } from 'react'
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

let lastSearchInput: SearchInput | null = null

export function useSearch(): UseSearchReturn {
  const [search, setSearch] = useState<SearchResponse | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [queryImage, setQueryImage] = useState<string | null>(null)
  const [queryLabel, setQueryLabel] = useState<string | null>(null)

  const runSearch = useCallback(async (input: SearchInput) => {
    lastSearchInput = input
    setSearching(true)
    setSearchError(null)
    try {
      if (input.path) {
        const response = await window.whichvideo.search.byPath(input.path)
        setSearch(response)
        setQueryImage(`file://${input.path}`)
        setQueryLabel(input.label ?? input.path)
      } else if (input.dataUrl) {
        const response = await window.whichvideo.search.byDataUrl(input.dataUrl)
        setSearch(response)
        setQueryImage(input.dataUrlPreview ?? input.dataUrl)
        setQueryLabel(input.label ?? '图片')
      } else if (input.url) {
        const response = await window.whichvideo.search.byUrl(input.url)
        setSearch(response)
        setQueryImage(null)
        setQueryLabel(response.queryImageUrl ?? input.label ?? input.url)
        if (response.error) setSearchError(response.error)
      } else {
        const clipboard = await window.whichvideo.search.byClipboard()
        if (!clipboard) {
          setSearchError('剪贴板里没有图片，请先复制一张图片再点这个按钮')
          return
        }
        setSearch(clipboard.response)
        setQueryImage(clipboard.dataUrl)
        setQueryLabel(input.label ?? '剪贴板图片')
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : String(err))
    } finally {
      setSearching(false)
    }
  }, [])

  const reSearch = useCallback(async () => {
    if (lastSearchInput) {
      await runSearch(lastSearchInput)
    }
  }, [runSearch])

  const clearSearch = useCallback(() => {
    setSearch(null)
    setSearchError(null)
    setQueryImage(null)
    setQueryLabel(null)
    lastSearchInput = null
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