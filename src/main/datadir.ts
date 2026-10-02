/**
 * 数据目录解析（便携 / 绿色模式）。
 *
 * 单独成模块是为了能在纯 Node 环境里跑单元测试，同时让主进程入口保持清爽。
 *
 * 判定优先级：
 *   1. 环境变量 WHICHVIDEO_DATA_DIR（可写时直接用它，适合放到移动硬盘）
 *   2. 便携版启动器注入的 PORTABLE_EXECUTABLE_DIR（electron-builder portable 目标）
 *   3. 打包后 exe 所在目录（直接解压到可写目录双击运行时）
 *   4. 默认 userData（安装版、开发模式）
 */
import { join, resolve } from 'node:path'

export interface DataDirInput {
  /** app.getPath('userData')：系统默认位置，也是迁移来源 */
  legacyDir: string
  /** 环境变量 WHICHVIDEO_DATA_DIR */
  envDir?: string
  /** 环境变量 PORTABLE_EXECUTABLE_DIR（electron-builder 便携版启动器注入） */
  portableDir?: string
  /** app.getPath('exe') 所在目录 */
  exeDir: string
  /** 是否打包后的应用 */
  isPackaged: boolean
  /** 可写性探测函数 */
  isWritable: (dir: string) => boolean
}

export interface DataDirResolution {
  dir: string
  portable: boolean
  source: 'env' | 'portable-launcher' | 'default'
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function resolveDataDir(input: DataDirInput): DataDirResolution {
  const legacyDir = input.legacyDir
  const envDir = clean(input.envDir)
  const portableDir = clean(input.portableDir)

  if (envDir && input.isWritable(envDir)) {
    return { dir: resolve(envDir), portable: true, source: 'env' }
  }

  if (portableDir && input.isWritable(portableDir)) {
    const candidate = join(portableDir, 'data')
    if (input.isWritable(candidate)) {
      return { dir: resolve(candidate), portable: true, source: 'portable-launcher' }
    }
  }

  if (input.isPackaged && input.isWritable(input.exeDir)) {
    const candidate = join(input.exeDir, 'data')
    if (input.isWritable(candidate)) {
      return { dir: resolve(candidate), portable: true, source: 'portable-launcher' }
    }
  }

  return { dir: legacyDir, portable: false, source: 'default' }
}

/** 便携模式需要在数据目录里留一个标记文件，方便用户确认当前是绿色模式 */
export function portableMarkerPath(dir: string): string {
  return join(dir, 'whichvideo.portable')
}

/** 迁移时需要一并带走的文件（SQLite 的 WAL 模式会有 -wal / -shm） */
export const DATABASE_FILES = ['whichvideo.db', 'whichvideo.db-wal', 'whichvideo.db-shm'] as const
