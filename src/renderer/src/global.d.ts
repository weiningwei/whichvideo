import type { WhichVideoApi } from '@shared/types'

declare global {
  interface Window {
    whichvideo: WhichVideoApi
  }

  // Vite 注入的环境变量。MODE 用于让 WebDriver 前端桥接只进入测试构建。
  interface ImportMetaEnv {
    readonly DEV: boolean
    readonly PROD: boolean
    readonly MODE: string
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}

export {}
