import type { LibraryEvent } from '@shared/types'

export type ImportProgressEvent = Extract<LibraryEvent, { type: 'import-progress' }>

/**
 * 把一条 import-progress 事件应用到状态上。
 *
 * - 批次号更小的是迟到的旧批次（并发导入、监听导入），丢弃，否则新批次的
 *   进度会被旧批次顶掉。
 * - finished = true 表示这批结束，清空显示；若它已经不是当前批次则保留。
 *
 * 抽成纯函数是为了能脱离 React 直接测（hook 的 effect 在测试里不执行）。
 */
export function applyImportProgress(
  prev: ImportProgressEvent | null,
  event: ImportProgressEvent
): ImportProgressEvent | null {
  if (prev && event.id < prev.id) return prev
  if (event.finished) return null
  return event
}
