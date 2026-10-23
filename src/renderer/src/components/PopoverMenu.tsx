import { useEffect, useRef, type ComponentProps, type ReactNode } from 'react'

export function usePopoverDismiss(active: boolean, selector: string, onClose: () => void, closeOnScroll = false): void {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    if (!active) return
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(selector)) onCloseRef.current()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopImmediatePropagation()
      onCloseRef.current()
    }
    document.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', escape, true)
    const scroll = () => onCloseRef.current()
    if (closeOnScroll) window.addEventListener('scroll', scroll, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('keydown', escape, true)
      if (closeOnScroll) window.removeEventListener('scroll', scroll, true)
    }
  }, [active, selector, closeOnScroll])
}

export function PopoverMenu({ className = '', children, ...props }: ComponentProps<'div'>) {
  return <div className={`popover p-1.5 ${className}`} {...props}>{children}</div>
}

export function PopoverItem({ label, hint, danger, ...props }: Omit<ComponentProps<'button'>, 'children'> & {
  label: ReactNode
  hint?: ReactNode
  danger?: boolean
}) {
  return (
    <button className={`flex w-full flex-col rounded-lg px-3 py-2 text-left hover:bg-surface-3 disabled:opacity-50 ${danger ? 'text-bad' : 'text-secondary'}`} {...props}>
      <span className="text-[12.5px]">{label}</span>
      {hint && <span className="mt-0.5 text-[10.5px] text-tertiary">{hint}</span>}
    </button>
  )
}
