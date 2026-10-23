/**
 * 浏览器存储的容错边界。WebView 禁用持久化、隐私模式或数据损坏时，
 * UI 仍使用本次会话的默认值，不让偏好设置影响核心功能。
 */
export function readStoredText(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeStoredText(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 持久化不可用时保留当前内存状态。
  }
}

export function readStoredJson(key: string): unknown {
  const value = readStoredText(key)
  if (value === null) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function writeStoredJson(key: string, value: unknown): void {
  try {
    writeStoredText(key, JSON.stringify(value))
  } catch {
    // 无法序列化的偏好值不应中断 UI 操作。
  }
}
