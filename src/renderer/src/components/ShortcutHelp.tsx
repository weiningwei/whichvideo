/**
 * 快捷键帮助面板（按 ? 唤出）。
 *
 * 内容从 lib/shortcuts.ts 生成，不另写一份 —— 避免"文档写的和实际能按的不一致"。
 */
import { useEffect } from 'react'
import { groupShortcuts, renderKeys } from '../lib/shortcuts'

interface Props {
  open: boolean
  onClose: () => void
  /** 当前在视频库页吗（分组相关的键在搜索页没意义） */
  inLibrary: boolean
}

export function ShortcutHelp({ open, onClose, inLibrary }: Props) {
  // 打开时 Esc 关闭、Tab 不逃出面板（焦点陷阱），点遮罩也能关
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === 'Tab') {
        // 面板内的按钮不多，Tab 直接锁住不让焦点跑到底下的表格去
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [open, onClose])

  if (!open) return null

  const groups = groupShortcuts()

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink-950/70 p-6 pt-[8vh] backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="键盘快捷键"
    >
      <div
        className="card max-h-[80vh] w-full max-w-2xl overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-[14px] font-semibold text-primary">键盘快捷键</h2>
            <p className="mt-0.5 text-[11.5px] text-muted">
              在列表里直接按；输入框聚焦时大部分键会暂时让位给文字输入。
            </p>
          </div>
          <button className="btn px-2 py-1 text-[12px] hover:bg-ink-700/70" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          {groups.map(({ group, items }) => (
            <section key={group}>
              <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-tertiary">
                {group}
              </h3>
              <dl className="flex flex-col gap-1">
                {items.map((s) => {
                  // 只在分组视图下生效的键，在搜索页显示为不可用
                  const dim = s.onlyGrouped && !inLibrary
                  return (
                    <div
                      key={`${s.group}-${s.keys}-${s.label}`}
                      className={`flex items-baseline gap-2 text-[11.5px] ${dim ? 'opacity-40' : ''}`}
                    >
                      <dt className="shrink-0">
                        {s.keys.split('+').map((k, i) => (
                          <span key={k}>
                            {i > 0 && (
                              <span className="mx-0.5 text-tertiary" aria-hidden="true">
                                +
                              </span>
                            )}
                            <kbd className="rounded border border-line bg-ink-900/70 px-1 py-0.5 font-mono text-[10.5px] text-secondary">
                              {renderKeys(k)}
                            </kbd>
                          </span>
                        ))}
                      </dt>
                      <dd className="min-w-0 flex-1 text-muted">{s.label}</dd>
                    </div>
                  )
                })}
              </dl>
            </section>
          ))}
        </div>

        <p className="mt-4 border-t border-line/70 pt-3 text-[10.5px] leading-relaxed text-tertiary">
          删除（Delete）只从索引库移除记录，不会删除磁盘文件。弹层打开时按 Esc 关闭。
        </p>
      </div>
    </div>
  )
}
