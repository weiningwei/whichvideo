/**
 * 主题（深色 / 浅色 / 跟随系统）。
 *
 * 主题值落在 <html data-theme="dark|light"> 上，index.css 里那两套
 * [data-theme] 选择器据此换掉所有语义 token 的色值——组件完全不需要知道
 * 当前是什么主题。
 *
 * 为什么不直接在 CSS 里用 prefers-color-scheme：那样"用户手动选浅色"就没法
 * 覆盖系统设置。系统主题的实时变化需要在 WebView 中监听 matchMedia，
 * 所以由这里统一处理，三种取值都能落到 data-theme 上。
 *
 * 选择持久化到 localStorage，键名带 wv- 前缀避免与其他应用串味。
 */
import { useCallback, useEffect, useState } from 'react'
import { readStoredText, writeStoredText } from '../lib/storage'

export type ThemeMode = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

const STORAGE_KEY = 'wv-theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

function readStored(): ThemeMode {
  const v = readStoredText(STORAGE_KEY)
  if (v === 'dark' || v === 'light' || v === 'system') return v
  return 'dark'
}

function systemTheme(): ResolvedTheme {
  return typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

function apply(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme
  // 系统窗口边框不跟 CSS，但 WebView 背景色会露出来
  document.body.style.backgroundColor = theme === 'light' ? '#f8fafc' : '#0b0f17'
}

export function useTheme() {
  const [initialMode] = useState<ThemeMode>(readStored)
  const [mode, setMode] = useState<ThemeMode>(initialMode)
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    initialMode === 'system' ? systemTheme() : initialMode
  )

  const sync = useCallback((next: ThemeMode) => {
    const r = next === 'system' ? systemTheme() : next
    setResolved(r)
    apply(r)
  }, [])

  useEffect(() => {
    sync(mode)
    writeStoredText(STORAGE_KEY, mode)
  }, [mode, sync])

  // 「跟随系统」时要跟随系统的实时变化（用户在 Windows 设置里切换深浅色）
  useEffect(() => {
    if (mode !== 'system') return
    const mq = window.matchMedia(DARK_QUERY)
    const onChange = () => {
      const r = mq.matches ? 'dark' : 'light'
      setResolved(r)
      apply(r)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [mode])

  const cycle = useCallback(() => {
    setMode((m) => (m === 'dark' ? 'light' : m === 'light' ? 'system' : 'dark'))
  }, [])

  return { mode, resolved, setMode, cycle }
}
