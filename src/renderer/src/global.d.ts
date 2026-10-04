import type { WhichVideoApi } from '@shared/types'

declare global {
  interface Window {
    whichvideo: WhichVideoApi
  }

  // Vite 注入的环境变量。渲染端只用到 DEV（判断是否在开发态）。
  interface ImportMetaEnv {
    readonly DEV: boolean
    readonly PROD: boolean
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}

export {}
