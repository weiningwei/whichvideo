import { useCallback, useRef, useState } from 'react'
import { type SearchResponse } from '@shared/types'

export interface UseSearchReturn {
  search: SearchResponse | null
  searching: boolean
  searchError: string | null
  queryImage: string | null
  queryLabel: string | null
  runSearch: (input: SearchInput) => Promise<SearchOutcome>
  reSearch: () => Promise<void>
  clearSearch: () => void
}

export interface SearchOutcome {
  ok: boolean
  error: string | null
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

  const runSearch = useCallback(async (input: SearchInput): Promise<SearchOutcome> => {
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
        if (currentRequest !== requestId.current) return { ok: false, error: null }
        applyResponse(response)
        setQueryImage(`file://${input.path}`)
        setQueryLabel(input.label ?? input.path)
        return { ok: !response.error, error: response.error ?? null }
      } else if (input.dataUrl) {
        const response = await window.whichvideo.search.byDataUrl(input.dataUrl)
        if (currentRequest !== requestId.current) return { ok: false, error: null }
        applyResponse(response)
        setQueryImage(input.dataUrlPreview ?? input.dataUrl)
        setQueryLabel(input.label ?? '图片')
        return { ok: !response.error, error: response.error ?? null }
      } else if (input.url) {
        const response = await window.whichvideo.search.byUrl(input.url)
        if (currentRequest !== requestId.current) return { ok: false, error: null }
        applyResponse(response)
        setQueryImage(null)
        setQueryLabel(response.queryImageUrl ?? input.label ?? input.url)
        return { ok: !response.error, error: response.error ?? null }
      } else {
        const clipboard = await window.whichvideo.search.byClipboard()
        if (currentRequest !== requestId.current) return { ok: false, error: null }
        if (!clipboard) {
          setSearchError('剪贴板里没有图片，请先复制一张图片再点这个按钮')
          return { ok: false, error: '剪贴板里没有图片，请先复制一张图片再点这个按钮' }
        }
        // 剪贴板解码失败同样由 response.error 返回；沿用其它输入路径的
        // 统一处理，避免界面把真实错误误显示成“没有匹配”。
        applyResponse(clipboard.response)
        setQueryImage(clipboard.dataUrl)
        setQueryLabel(input.label ?? '剪贴板图片')
        return { ok: !clipboard.response.error, error: clipboard.response.error ?? null }
      }
    } catch (err) {
      if (currentRequest !== requestId.current) return { ok: false, error: null }
      const message = err instanceof Error ? err.message : String(err)
      setSearchError(message)
      return { ok: false, error: message }
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
