/**
 * 主进程内的服务契约。
 *
 * 跨模块协作只依赖这里声明的形状，不依赖具体类——模块之间不互相 import 实现，
 * 组合点集中在 index.ts 的 bootstrap（依赖注入）。
 */
import type { LibraryEvent } from '@shared/types'

/**
 * 把库变化事件广播给渲染端。
 * 定义在此处收口：此前 scan.ts 叫 EventEmitter、watcher.ts 叫 Emit、
 * ipc.ts 内联写 `(event: LibraryEvent) => void`，三个名字同一个概念。
 */
export type EmitLibraryEvent = (event: LibraryEvent) => void

/**
 * 磁盘文件变化：watcher 产生，indexer 消费。
 *
 * 此前 FolderWatcher 构造函数直接吃一个 Indexer 并调它的三个方法，
 * 监听模块因此依赖抽帧模块；改成事件后 watcher 不再认识 indexer，
 * 两边各自只依赖本文件声明的契约。
 */
export type LibraryFileEvent =
  | { type: 'file-upsert'; path: string; folderId: number | null }
  | { type: 'file-removed'; path: string }
  | { type: 'directory-removed'; path: string }

/** 文件事件总线：watcher 与 indexer 之间唯一的耦合点 */
export interface EventBus {
  emit(event: LibraryFileEvent): void
  /** 订阅文件事件，返回取消订阅函数 */
  on(handler: (event: LibraryFileEvent) => void): () => void
}

/**
 * 极简同步事件总线：进程内单线程，广播即同步调用各 handler。
 * emit 时对 handler 集合做快照，允许 handler 在回调里退订。
 */
export function createEventBus(): EventBus {
  const handlers = new Set<(event: LibraryFileEvent) => void>()
  return {
    emit(event) {
      for (const handler of [...handlers]) handler(event)
    },
    on(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    }
  }
}
