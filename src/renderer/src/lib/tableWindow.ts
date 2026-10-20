/**
 * 视频表格的挂载窗口。
 *
 * 列表本身是全量数据（refreshVideos 会分页拉完），但一次性把几千行挂进 DOM 的
 * 代价不只是渲染：每个 VideoRow 挂载时都会请求自己的缩略图 dataUrl，索引中的行
 * 还会每 500ms 轮询一次帧进度。导入几千个视频完成时那一下卡顿，主要来自这里。
 *
 * 因此表格先只挂前 ROW_CHUNK 行，滚到接近底部再追加；光标（键盘导航）走到未
 * 挂载的行时也必须把那段补上，否则焦点会停在屏幕上不存在的行上。
 */

export const ROW_CHUNK = 150

/** 光标落在已挂载范围之外时，至少挂到光标行之后再留一个 chunk。 */
export function limitForFocus(
  limit: number,
  focusRow: number,
  total: number,
  chunk: number = ROW_CHUNK
): number {
  if (focusRow < 0 || focusRow < limit) return limit
  return Math.min(total, Math.max(limit, focusRow + chunk))
}

/** 滚到底部时追加一个 chunk，最多到总行数。 */
export function growLimit(limit: number, total: number, chunk: number = ROW_CHUNK): number {
  return Math.min(total, limit + chunk)
}
