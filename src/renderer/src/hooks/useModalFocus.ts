import { useEffect, useRef } from 'react'

const FOCUSABLE = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

/**
 * 为覆盖层提供一致的键盘焦点行为：打开时进入弹窗，Tab 不会穿透背景，
 * 关闭后回到原触发元素。调用方仍自行处理 Escape 和点击遮罩关闭。
 */
export function useModalFocus<T extends HTMLElement>(active: boolean, onClose?: () => void) {
  const dialogRef = useRef<T>(null)

  useEffect(() => {
    if (!active) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusFirst = () => {
      const dialog = dialogRef.current
      if (!dialog) return
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? dialog).focus({ preventScroll: true })
    }
    const frame = requestAnimationFrame(focusFirst)
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onClose) {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const dialog = dialogRef.current
      if (!dialog) return
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) {
        event.preventDefault()
        dialog.focus({ preventScroll: true })
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }
    window.addEventListener('keydown', handleKey, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', handleKey, true)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [active, onClose])

  return dialogRef
}
