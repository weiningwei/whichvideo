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
  if (idx === 0 && path.startsWith('/')) return '/'
  return idx > 0 ? path.slice(0, idx) : path
}

/** 把绝对路径变成相对某个根的短路径，便于在列表里显示上下文 */
export function shortPath(path: string, roots: string[]): string {
  return shortDir(path, roots) + fileNameOf(path)
}

/**
 * 只要目录部分（不含文件名）。
 *
 * 列表里第一行已经显示文件名，若第二行再用 shortPath 会把文件名重复一次
 * （旧实现如此，"剧名.mkv" 会连着出现两遍）。这里单独提供目录形式。
 */
export function shortDir(path: string, roots: string[]): string {
  const unix = path.startsWith('/')
  const separator = unix ? '/' : '\\'
  const lower = unix ? path : path.toLowerCase()
  for (const root of roots) {
    const r = unix ? root : root.toLowerCase()
    // 目录名只是前缀不代表归属：Movies2 不能被 Movies 当作子目录。
    if (lower.startsWith(r) && (/[\\/]$/.test(root) || /[\\/]/.test(path.charAt(root.length)))) {
      const cut = path.slice(root.length).replace(/^[\\/]+/, '')
      // 注意 lastIndexOf 找不到时返回 -1，slice(0, -1) 会砍掉最后一个字符。
      // 文件直接位于根目录时（cut 里没有分隔符）必须走这个分支。
      const idx = Math.max(cut.lastIndexOf('\\'), cut.lastIndexOf('/'))
      if (idx < 0) return ''
      return cut.slice(0, idx) + separator
    }
  }
  const dir = dirNameOf(path)
  if (dir === '/') return '/'
  const parts = dir.split(/[\\/]/)
  return parts.length > 2 ? `…${separator}${parts.slice(-2).join(separator)}${separator}` : dir ? dir + separator : ''
}

export function scoreColor(score: number): string {
  if (score >= 0.84) return 'text-ok'
  if (score >= 0.76) return 'text-warn'
  return 'text-muted'
}

export function scoreLabel(score: number): string {
  if (score >= 0.92) return '很相似'
  if (score >= 0.84) return '较相似'
  if (score >= 0.76) return '有些相似'
  return '相似度较低'
}
