import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { readStoredJson, writeStoredJson } from '../lib/storage'

const COLUMN_WIDTHS_KEY = 'wv-library-column-widths'
const DEFAULT_COLUMN_WIDTHS = [360, 128, 96, 96] as const
const MIN_COLUMN_WIDTHS = [240, 112, 88, 88] as const
export const COLUMN_LABELS = ['视频', '状态', '时长', '大小'] as const
export const ACTION_COLUMN_WIDTH = 88

function loadColumnWidths(): { widths: number[]; firstFixed: boolean } {
  const saved = readStoredJson(COLUMN_WIDTHS_KEY)
  if (typeof saved === 'object' && saved !== null && 'firstFixed' in saved && 'widths' in saved &&
    typeof saved.firstFixed === 'boolean' && Array.isArray(saved.widths) && saved.widths.length === DEFAULT_COLUMN_WIDTHS.length &&
    saved.widths.every((width: unknown, index: number) => typeof width === 'number' && Number.isFinite(width) && width >= MIN_COLUMN_WIDTHS[index] && width <= 2000)) {
    return { widths: saved.widths, firstFixed: saved.firstFixed }
  }
  return { widths: [...DEFAULT_COLUMN_WIDTHS], firstFixed: false }
}

export function useLibraryColumns(scrollRef: RefObject<HTMLDivElement | null>) {
  const [initialColumnLayout] = useState(loadColumnWidths)
  const [columnWidths, setColumnWidths] = useState(initialColumnLayout.widths)
  const [firstColumnFixed, setFirstColumnFixed] = useState(initialColumnLayout.firstFixed)
  const [tableViewportWidth, setTableViewportWidth] = useState(0)
  const resizeRef = useRef<{ index: number; pointerId: number; startX: number; startWidth: number } | null>(null)
  const columnWidthsRef = useRef(columnWidths)
  const firstColumnFixedRef = useRef(firstColumnFixed)
  columnWidthsRef.current = columnWidths
  firstColumnFixedRef.current = firstColumnFixed
  useEffect(() => {
    const box = scrollRef.current
    if (!box) return
    const observer = new ResizeObserver(() => setTableViewportWidth(box.clientWidth))
    observer.observe(box)
    setTableViewportWidth(box.clientWidth)
    return () => observer.disconnect()
  }, [])

  const maxColumnWidth = (index: number): number => {
    const otherWidths = columnWidths.reduce((sum, width, column) => {
      if (column === index) return sum
      return sum + (column === 0 && !firstColumnFixed ? MIN_COLUMN_WIDTHS[0] : width)
    }, ACTION_COLUMN_WIDTH)
    return Math.max(MIN_COLUMN_WIDTHS[index], Math.min(2000, tableViewportWidth - otherWidths))
  }

  const resizeHandle = (index: number) => (
    <span
      role="separator"
      aria-label={`调整${COLUMN_LABELS[index]}列宽`}
      aria-orientation="vertical"
      aria-valuemin={MIN_COLUMN_WIDTHS[index]}
      aria-valuemax={maxColumnWidth(index)}
      aria-valuenow={displayColumnWidths[index]}
      tabIndex={0}
      title={`拖动调整${COLUMN_LABELS[index]}列宽`}
      className="group/resize absolute -right-1 top-0 z-20 flex h-full w-2 cursor-col-resize touch-none items-center justify-center focus-visible:outline-accent"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        event.stopPropagation()
        const change = event.key === 'ArrowRight' ? 10 : -10
        const next = columnWidths.map((value, column) => column === index
          ? Math.min(maxColumnWidth(index), Math.max(MIN_COLUMN_WIDTHS[index], displayColumnWidths[index] + change)) : value)
        if (index === 0) { firstColumnFixedRef.current = true; setFirstColumnFixed(true) }
        columnWidthsRef.current = next
        setColumnWidths(next)
        writeStoredJson(COLUMN_WIDTHS_KEY, { widths: next, firstFixed: firstColumnFixedRef.current })
      }}
      onPointerDown={(event: ReactPointerEvent<HTMLSpanElement>) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        if (index === 0) { firstColumnFixedRef.current = true; setFirstColumnFixed(true) }
        event.currentTarget.setPointerCapture(event.pointerId)
        resizeRef.current = {
          index, pointerId: event.pointerId, startX: event.clientX,
          startWidth: event.currentTarget.parentElement?.getBoundingClientRect().width ?? columnWidths[index]
        }
      }}
      onPointerMove={(event: ReactPointerEvent<HTMLSpanElement>) => {
        const resize = resizeRef.current
        if (!resize || resize.pointerId !== event.pointerId) return
        const width = Math.min(maxColumnWidth(resize.index), Math.max(MIN_COLUMN_WIDTHS[resize.index], Math.round(resize.startWidth + event.clientX - resize.startX)))
        setColumnWidths((current) => current.map((value, column) => column === resize.index ? width : value))
      }}
      onPointerUp={(event: ReactPointerEvent<HTMLSpanElement>) => {
        const resize = resizeRef.current
        if (!resize || resize.pointerId !== event.pointerId) return
        const width = Math.min(maxColumnWidth(resize.index), Math.max(MIN_COLUMN_WIDTHS[resize.index], Math.round(resize.startWidth + event.clientX - resize.startX)))
        const next = columnWidthsRef.current.map((value, column) => column === resize.index ? width : value)
        columnWidthsRef.current = next
        setColumnWidths(next)
        resizeRef.current = null
        writeStoredJson(COLUMN_WIDTHS_KEY, { widths: next, firstFixed: firstColumnFixedRef.current })
      }}
      onPointerCancel={() => { resizeRef.current = null }}
    >
      <span className="h-5 w-px bg-line group-hover/resize:w-0.5 group-hover/resize:bg-accent" />
    </span>
  )

  const displayColumnWidths = [
    firstColumnFixed ? columnWidths[0] : Math.min(2000, Math.max(columnWidths[0], tableViewportWidth - columnWidths.slice(1).reduce((sum, width) => sum + width, ACTION_COLUMN_WIDTH))),
    ...columnWidths.slice(1)
  ]
  const tableWidth = displayColumnWidths.reduce((sum, width) => sum + width, ACTION_COLUMN_WIDTH)
  return { displayColumnWidths, tableWidth, resizeHandle }
}
