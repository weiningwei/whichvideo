export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '未知'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function formatPercent(value: number): string {
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`
}

export function formatClock(ms: number | null | undefined): string {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds()
  ).padStart(2, '0')}`
}

export function fileNameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return idx >= 0 ? path.slice(idx + 1) : path
}

export function dirNameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return idx > 0 ? path.slice(0, idx) : path
}

/** 把绝对路径变成相对某个根的短路径，便于在列表里显示上下文 */
export function shortPath(path: string, roots: string[]): string {
  const lower = path.toLowerCase()
  for (const root of roots) {
    const r = root.toLowerCase()
    if (lower.startsWith(r)) {
      const cut = path.slice(root.length).replace(/^[\\/]+/, '')
      return cut || fileNameOf(path)
    }
  }
  const dir = dirNameOf(path)
  const parts = dir.split(/[\\/]/)
  return parts.length > 2 ? `…\\${parts.slice(-2).join('\\')}\\${fileNameOf(path)}` : path
}

export function scoreColor(score: number): string {
  if (score >= 0.92) return 'text-[#34d399]'
  if (score >= 0.84) return 'text-[#a3e635]'
  if (score >= 0.76) return 'text-[#fbbf24]'
  return 'text-[#f87171]'
}

export function scoreLabel(score: number): string {
  if (score >= 0.92) return '几乎确定'
  if (score >= 0.84) return '高度相似'
  if (score >= 0.76) return '可能匹配'
  return '弱匹配'
}
