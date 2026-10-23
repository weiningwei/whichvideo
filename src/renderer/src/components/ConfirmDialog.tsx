import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { useModalFocus } from '../hooks/useModalFocus'

export interface ConfirmOptions {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
}

type ConfirmAction = (options: ConfirmOptions) => Promise<boolean>
const ConfirmContext = createContext<ConfirmAction>(async () => false)

interface PendingConfirm extends ConfirmOptions {
  resolve: (accepted: boolean) => void
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const confirm = useCallback<ConfirmAction>((options) => new Promise((resolve) => {
    setPending({ ...options, resolve })
  }), [])
  const finish = useCallback((accepted: boolean) => {
    setPending((current) => {
      current?.resolve(accepted)
      return null
    })
  }, [])
  const cancel = useCallback(() => finish(false), [finish])
  const dialogRef = useModalFocus<HTMLDivElement>(pending !== null, cancel)

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ink-950/70 p-5 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onMouseDown={cancel}>
          <div ref={dialogRef} tabIndex={-1} className="card w-full max-w-md p-5" onMouseDown={(event) => event.stopPropagation()}>
            <h2 id="confirm-title" className="text-[15px] font-semibold text-primary">{pending.title}</h2>
            <p className="mt-2 whitespace-pre-line text-[12px] leading-5 text-secondary">{pending.message}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button className="btn" onClick={cancel}>取消</button>
              <button className={`btn ${pending.danger ? 'btn-danger' : 'border-accent bg-accent text-surface-0'}`} onClick={() => finish(true)}>
                {pending.confirmLabel ?? '确认'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmAction {
  return useContext(ConfirmContext)
}
