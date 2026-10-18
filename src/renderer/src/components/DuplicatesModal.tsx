import { useMemo, useState } from 'react'
import type { DuplicatePair } from '@shared/types'
import { buildDuplicateGroups, keptInGroup } from '../lib/duplicates'
import { formatBytes, formatDuration, formatPercent } from '../lib/format'

interface DuplicatesModalProps {
  duplicates: DuplicatePair[]
  onClose: () => void
  onRemoveVideos: (ids: number[]) => void
  /** 移除成功后回调，让父组件从结果集里剔除含这些视频的 pair（结果与库同步） */
  onPrune: (removedIds: number[]) => void
}

/**
 * 库内查重结果弹层。自带 keptIds（每组用户指定的保留项）与 duplicateGroups
 * 派生，关闭即卸载、重开清空 —— 库内容随时变化，缓存旧结果反而会误导。
 */
export function DuplicatesModal({ duplicates, onClose, onRemoveVideos, onPrune }: DuplicatesModalProps) {
  // 两两 pair 聚合成相似组（连通分量）：AB、BC 相似 → A/B/C 同组，
  // dupeGuru 式交互 —— 组内挑一个保留、其余移除，不逐对处理。
  const duplicateGroups = useMemo(() => buildDuplicateGroups(duplicates), [duplicates])
  // 每组用户指定的保留项（videoId）；未指定时用组默认（体积最大）。
  // 移除后对应 id 自动清除。
  const [keptIds, setKeptIds] = useState<Set<number>>(new Set())

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink-950/70 p-6 pt-[8vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-line bg-surface-1 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-[14px] font-medium text-primary">库内查重结果</div>
            <div className="text-[11px] text-muted">
              {duplicateGroups.length === 0
                ? '没有发现画面高度相似的视频'
                : `发现 ${duplicateGroups.length} 组相似视频 · 组内保留一个、其余建议移除`}
              {' · '}同剧不同集的相同场景可能被列入，请自行核对
            </div>
          </div>
          <button className="btn px-2 py-1 text-[11px]" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="flex flex-col gap-3">
          {duplicateGroups.map((group, gi) => {
            const keep = keptInGroup(group, keptIds)
            const toRemove = group.members.filter((m) => m.id !== keep.id)
            return (
              <div key={group.id} className="rounded-xl border border-line p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-[12.5px] text-primary">
                    相似组 {gi + 1}
                    <span className="ml-2 text-[11px] text-muted">
                      {group.members.length} 个视频 · 建议保留体积最大的
                    </span>
                  </div>
                  {group.identicalFile && (
                    <span className="rounded border border-bad/40 bg-bad/10 px-1.5 py-0.5 text-[10.5px] text-bad">
                      完全相同文件（SHA-256 一致）
                    </span>
                  )}
                  <div className={`shrink-0 text-[13px] font-semibold ${group.bestScore >= 0.95 ? 'text-bad' : 'text-warn'}`}>
                    {formatPercent(group.bestScore)}
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  {group.members.map((m) => {
                    const isKeep = m.id === keep.id
                    return (
                      <div
                        key={m.id}
                        className={`flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5 ${
                          isKeep ? 'border-ok/40 bg-ok/10' : 'border-line bg-ink-900/40'
                        }`}
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <span
                            className={`shrink-0 rounded px-1 py-0.5 text-[10px] ${
                              isKeep ? 'bg-ok/20 text-ok' : 'bg-bad/10 text-bad'
                            }`}
                          >
                            {isKeep ? '保留' : '将移除'}
                          </span>
                          <div className="flex min-w-0 flex-col">
                            <span className="truncate text-[12px] text-primary" title={m.name}>{m.name}</span>
                            <span className="truncate text-[10.5px] text-muted" title={m.dir}>{m.dir}</span>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2 text-[10.5px] text-muted">
                          <span>{formatBytes(m.size)}</span>
                          <span>{formatDuration(m.duration)}</span>
                          {!isKeep && (
                            <button
                              className="btn px-1.5 py-0.5 hover:bg-ink-700/70"
                              onClick={() => setKeptIds((prev) => new Set(prev).add(m.id))}
                              title="改为保留这一个，其余标记移除"
                            >
                              保留这个
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
                {toRemove.length > 0 && (
                  <div className="mt-2 flex items-center justify-end gap-2">
                    <button
                      className="btn btn-danger px-2 py-1 text-[11px] hover:bg-bad/10"
                      onClick={() => {
                        const ids = toRemove.map((m) => m.id)
                        if (
                          !window.confirm(
                            `从索引库移除这 ${ids.length} 个视频？\n保留：${keep.path}\n不会删除磁盘文件。`
                          )
                        ) {
                          return
                        }
                        onRemoveVideos(ids)
                        onPrune(ids)
                        setKeptIds((prev) => {
                          const next = new Set(prev)
                          for (const id of ids) next.delete(id)
                          return next
                        })
                      }}
                    >
                      移除其余 {toRemove.length} 个（保留 {keep.name}）
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
