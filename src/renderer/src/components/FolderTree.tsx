import { useMemo, useRef, useState } from 'react'
import type { VideoRecord, WatchedFolder } from '@shared/types'
import { buildFolderTree, type DirNode } from '../lib/libraryTree'

interface FolderTreeProps {
  folders: WatchedFolder[]
  videos: VideoRecord[]
  selectedDir: string | null
  onSelectDir: (dir: string | null) => void
}

/** 文件夹只承担导航职责，批量选择统一在视频列表完成。 */
export function FolderTree({ folders, videos, selectedDir, onSelectDir }: FolderTreeProps) {
  const tree = useMemo(() => buildFolderTree(folders, videos), [folders, videos])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(tree.map((r) => r.path)))
  const containerRef = useRef<HTMLDivElement>(null)

  const toggle = (path: string) => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })

  const focusSibling = (nodeId: string, delta: number) => {
    const rows = Array.from(containerRef.current?.querySelectorAll<HTMLElement>('[data-tree-row]') ?? [])
    const index = rows.findIndex((row) => row.dataset.nodeId === nodeId)
    rows[Math.max(0, Math.min(rows.length - 1, index + delta))]?.focus()
  }

  const renderNode = (node: DirNode): React.ReactNode => {
    const open = expanded.has(node.path)
    return (
      <div key={node.id}>
        <TreeRow
          nodeId={node.id}
          depth={node.depth + 1}
          name={node.name}
          count={node.videoCount}
          open={open}
          hasChildren={node.children.length > 0}
          selected={selectedDir === node.path}
          onSelect={() => onSelectDir(node.path)}
          onToggle={() => toggle(node.path)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault(); focusSibling(node.id, e.key === 'ArrowDown' ? 1 : -1)
            } else if (e.key === 'ArrowRight' && node.children.length > 0) {
              e.preventDefault(); if (!open) toggle(node.path); else focusSibling(node.id, 1)
            } else if (e.key === 'ArrowLeft' && open) {
              e.preventDefault(); toggle(node.path)
            } else if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault(); onSelectDir(node.path)
            }
          }}
        />
        {open && node.children.map(renderNode)}
      </div>
    )
  }

  return (
    <aside ref={containerRef} data-folder-tree className="w-56 shrink-0 overflow-y-auto border-r border-line bg-surface-1 p-2">
      <div className="px-2 pb-2 pt-1 text-[10.5px] font-medium uppercase tracking-wider text-tertiary">浏览</div>
      <TreeRow
        nodeId="__all"
        depth={0}
        name="全部视频"
        count={videos.length}
        open={false}
        hasChildren={false}
        selected={selectedDir === null}
        onSelect={() => onSelectDir(null)}
        onToggle={() => {}}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); focusSibling('__all', 1) } }}
      />
      {folders.length === 0 ? (
        <div className="px-2 py-4 text-[11.5px] text-tertiary">没有监视目录</div>
      ) : (
        <div className="mt-1">{tree.map(renderNode)}</div>
      )}
    </aside>
  )
}

function TreeRow(props: {
  nodeId: string
  depth: number
  name: string
  count: number
  open: boolean
  hasChildren: boolean
  selected: boolean
  onSelect: () => void
  onToggle: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
}) {
  return (
    <div
      data-tree-row
      data-node-id={props.nodeId}
      tabIndex={0}
      role="treeitem"
      aria-selected={props.selected}
      onKeyDown={props.onKeyDown}
      onClick={props.onSelect}
      className={`group flex h-8 cursor-pointer items-center gap-1.5 rounded-lg pr-2 text-[12px] outline-none ${
        props.selected ? 'bg-accent-soft font-medium text-accent' : 'text-secondary hover:bg-surface-3 hover:text-primary'
      }`}
      style={{ paddingLeft: `${8 + props.depth * 12}px` }}
    >
      <button
        tabIndex={-1}
        className={`grid h-4 w-4 shrink-0 place-items-center text-[9px] text-tertiary ${props.hasChildren ? '' : 'invisible'}`}
        onClick={(e) => { e.stopPropagation(); props.onToggle() }}
        aria-label={props.open ? '折叠' : '展开'}
      >
        {props.open ? '▼' : '▶'}
      </button>
      <span className="min-w-0 flex-1 truncate" title={props.name}>{props.name}</span>
      <span className="text-[10px] tabular-nums text-tertiary">{props.count}</span>
    </div>
  )
}
