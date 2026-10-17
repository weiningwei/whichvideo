import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 纯渲染端构建（Tauri 用）。Electron 仍走 electron.vite.config.ts，两套共存、互不干扰。
const root = process.cwd()

export default defineConfig({
  root: resolve(root, 'src', 'renderer'),
  resolve: {
    alias: {
      '@renderer': resolve(root, 'src', 'renderer', 'src'),
      '@shared': resolve(root, 'src', 'shared'),
    },
  },
  plugins: [react(), tailwindcss()],
  build: {
    // 相对 root(src/renderer) 输出的绝对目录：仓库根 /dist，对应 tauri.conf frontendDist "../dist"
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
  },
  server: {
    // Tauri 约定端口；strictPort 保证 devUrl 稳定
    port: 1420,
    strictPort: true,
    host: true,
  },
})
