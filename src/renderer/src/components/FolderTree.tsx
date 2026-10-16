import { useMemo, useRef, useState } from 'react'
import type { VideoRecord, WatchedFolder } from '@shared/types'
import { buildFolderTree, videosUnderDir, type DirNode } from '../lib/libraryTree'

interface FolderTreeProps {
  folders: WatchedFolder[]
  videos: VideoRecord[]
  /** 当前地址栏所在目录（null = 整库） */
  selectedDir: string | null
  /** 点节点 / 「全部」时切换地址栏 */
  onSelectDir: (dir: string | null) => void
  selectedVideoIds: Set<number>
  /** 勾选节点复选框：批量选中或取消该目录下全部视频 */
  onSetDirSelection: (ids: number[], selected: boolean) => void
}

/**
 * 左侧文件夹树（资源管理器「导航窗格」）。
 *
 * - 监听目录为根，「全部」虚拟根 = 整库（selectedDir = null）。
 * - 节点复选框 = 选中该目录下的全部视频（递归）：全选打勾、部分选中半勾、
 *   全空不勾；点击在「全选 / 全不选」间切换。
 * - 单击节点名 = 地址栏定位到该目录（右侧只显示其下视频），不移动视频光标。
 * - 自带键盘导航（方向键 / Enter），焦点在树内时全局列表快捷键让位给树。
 *
 * 展开状态是组件内部 state（不持久化）：默认只展开各监听根，深层按需展开。
 */
export function FolderTree({
  folders,
  videos,
  selectedDir,
  onSelectDir,
  selectedVideoIds,
  onSetDirSelection
}: FolderTreeProps) {
  const tree = useMemo(() => buildFolderTree(folders, videos), [folders, videos])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(tree.map((r) => r.path)))
  const containerRef = useRef<HTMLDivElement>(null)

  const toggleExpand = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  // 键盘导航：在树内用方向键移动焦点；Enter 选目录；←→ 折叠/展开。
  const onRowKeyDown = (e: React.KeyboardEvent, node: DirNode) => {
    const rows = Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>('[data-tree-row]') ?? []
    )
    const idx = rows.findIndex((r) => r.dataset.nodeId === node.id)
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        rows[Math.min(rows.length - 1, idx + 1)]?.focus()
        break
      case 'ArrowUp':
        e.preventDefault()
        rows[Math.max(0, idx - 1)]?.focus()
        break
      case 'ArrowRight':
        e.preventDefault()
        if (node.children.length > 0 && !expanded.has(node.path)) toggleExpand(node.path)
        else rows[idx + 1]?.focus()
        break
      case 'ArrowLeft':
        e.preventDefault()
        if (node.children.length > 0 && expanded.has(node.path)) toggleExpand(node.path)
        else if (node.parentId) {
          const parent = rows.find((r) => r.dataset.nodeId === node.parentId)
          parent?.focus()
        }
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        onSelectDir(node.path)
        break
    }
  }

  const allIds = useMemo(() => videos.map((v) => v.id), [videos])

  // 「全部」虚拟根
  const AllRoot = (
    <TreeRow
      key="__all"
      nodeId="__all"
      depth={0}
      name="全部视频"
      count={videos.length}
      expanded={false}
      hasChildren={false}
      selected={selectedDir === null}
      checked={selectedVideoIds.size > 0 && allIds.every((id) => selectedVideoIds.has(id))}
      indeterminate={selectedVideoIds.size > 0 && allIds.some((id) => selectedVideoIds.has(id)) && !allIds.every((id) => selectedVideoIds.has(id))}
      onSelect={() => onSelectDir(null)}
      onToggleCheck={() => onSetDirSelection(allIds, !(selectedVideoIds.size > 0 && allIds.every((id) => selectedVideoIds.has(id))))}
      onToggleExpand={() => {}}
      onKeyDown={(e) => {
        const rows = Array.from(containerRef.current?.querySelectorAll<HTMLElement>('[data-tree-row]') ?? [])
        const idx = rows.findIndex((r) => r.dataset.nodeId === '__all')
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          rows[Math.min(rows.length - 1, idx + 1)]?.focus()
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          rows[0]?.focus()
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelectDir(null)
        }
      }}
    />
  )

  const renderNode = (node: DirNode): React.ReactNode => {
    const isOpen = expanded.has(node.path)
    const ids = videosUnderDir(videos, node.path, true).map((v) => v.id)
    const all = ids.length > 0 && ids.every((id) => selectedVideoIds.has(id))
    const some = ids.length > 0 && ids.some((id) => selectedVideoIds.has(id))
    return (
      <div key={node.id}>
        <TreeRow
          nodeId={node.id}
          depth={node.depth + 1}
          name={node.name}
          count={node.videoCount}
          expanded={isOpen}
          hasChildren={node.children.length > 0}
          selected={selectedDir === node.path}
          checked={all}
          indeterminate={some && !all}
          onSelect={() => onSelectDir(node.path)}
          onToggleCheck={() => onSetDirSelection(ids, !all)}
          onToggleExpand={() => toggleExpand(node.path)}
          onKeyDown={(e) => onRowKeyDown(e, node)}
        />
        {isOpen && node.children.map((child) => renderNode(child))}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      data-folder-tree
      className="flex w-60 shrink-0 flex-col overflow-auto border-r border-line/70 bg-surface-1"
    >
      <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-tertiary">文件夹</div>
      {folders.length === 0 ? (
        <div className="px-3 py-2 text-[11.5px] text-muted">还没有监听目录</div>
      ) : (
        <div className="pb-2">
          {AllRoot}
          {tree.map((root) => renderNode(root))}
        </div>
      )}
    </div>
  )
}

interface TreeRowProps {
  nodeId: string
  depth: number
  name: string
  count: number
  expanded: boolean
  hasChildren: boolean
  selected: boolean
  checked: boolean
  indeterminate: boolean
  onSelect: () => void
  onToggleCheck: () => void
  onToggleExpand: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
}

function TreeRow({
  nodeId,
  depth,
  name,
  count,
  expanded,
  hasChildren,
  selected,
  checked,
  indeterminate,
  onSelect,
  onToggleCheck,
  onToggleExpand,
  onKeyDown
}: TreeRowProps) {
  const checkboxRef = useRef<HTMLInputElement>(null)
  // 半选状态只能靠 DOM 属性设置（无 React 受控属性）
  const setIndeterminate = (el: HTMLInputElement | null) => {
    if (el) el.indeterminate = indeterminate
  }
  return (
    <div
      data-tree-row
      data-node-id={nodeId}
      tabIndex={0}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={hasChildren ? expanded : undefined}
      onKeyDown={onKeyDown}
      onClick={onSelect}
      className={`group flex cursor-pointer items-center gap-1 py-1 pr-2 text-[12px] outline-none ${
        selected ? 'bg-row-selected' : 'hover:bg-row-hover'
      }`}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
    >
      {/* 复选框：选中该目录下全部视频（独立于地址栏定位） */}
      <input
        type="checkbox"
        ref={(el) => {
          checkboxRef.current = el
          setIndeterminate(el)
        }}
        checked={checked}
        onClick={(e) => e.stopPropagation()}
        onChange={onToggleCheck}
        title="选中该目录下全部视频"
        className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent"
      />
      {/* 展开/折叠箭头（仅在有子目录时） */}
      {hasChildren ? (
        <span
          className="flex w-4 shrink-0 items-center justify-center text-tertiary transition-transform duration-150"
          onClick={(e) => {
            e.stopPropagation()
            onToggleExpand()
          }}
          style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}
        >
          ▶
        </span>
      ) : (
        <span className="w-4 shrink-0" />
      )}
      <span className={`min-w-0 flex-1 truncate ${selected ? 'font-medium text-accent' : 'text-primary'}`} title={name}>
        {name}
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-tertiary">{count}</span>
    </div>
  )
}
