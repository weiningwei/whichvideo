/**
 * 主题（深色 / 浅色 / 跟随系统）。
 *
 * 主题值落在 <html data-theme="dark|light"> 上，index.css 里那两套
 * [data-theme] 选择器据此换掉所有语义 token 的色值——组件完全不需要知道
 * 当前是什么主题。
 *
 * 为什么不直接在 CSS 里用 prefers-color-scheme：那样"用户手动选浅色"就没法
 * 覆盖系统设置。Electron 也拿不到 CSS media query 的实时变化（要在渲染端
 * 监听 matchMedia），所以由这里统一处理，三种取值都能落到 data-theme 上。
 *
 * 选择持久化到 localStorage，键名带 wv- 前缀避免与其他应用串味。
 */
import { useCallback, useEffect, useState } from 'react'

export type ThemeMode = 'dark' | 'light' | 'system'
/** data-theme 上真正落下的值 */
export type ResolvedTheme = 'dark' | 'light'

const STORAGE_KEY = 'wv-theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

function readStored(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'dark' || v === 'light' || v === 'system') return v
  } catch {
    /* 隐私模式下 localStorage 可能抛错，用默认即可 */
  }
  return 'dark'
}

function systemTheme(): ResolvedTheme {
  return typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

function apply(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme
  // Electron 的原生标题栏 / 窗口边框不跟 CSS，但窗口背景色会露出来
  document.body.style.backgroundColor = theme === 'light' ? '#f8fafc' : '#0b0f17'
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(readStored)
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    readStored() === 'system' ? systemTheme() : (readStored() as ResolvedTheme)
  )

  const sync = useCallback((next: ThemeMode) => {
    const r = next === 'system' ? systemTheme() : next
    setResolved(r)
    apply(r)
  }, [])

  // 首次挂载 + 模式变化时落地
  useEffect(() => {
    sync(mode)
    try {
      localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      /* 存不下不影响本次会话使用 */
    }
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
