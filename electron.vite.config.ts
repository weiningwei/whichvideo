import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 注意：这里刻意不用 __dirname。
// electron-vite 加载本配置时会依据 package.json 的 type 字段决定按 ESM 还是 CJS 解析，
// 而 __dirname 与 import.meta.dirname 各自只在其一可用，用错会直接导致配置加载失败。
// 路径统一以项目根目录为基准（pnpm 脚本都在根目录执行），并在下面校验这一点。
const root = process.cwd()
const pathOf = (...parts: string[]): string => resolve(root, ...parts)

if (!existsSync(pathOf('src', 'main', 'index.ts'))) {
  throw new Error(
    `请在项目根目录执行构建（当前工作目录：${root}）。` +
      ' 期望能找到 src/main/index.ts —— 用 pnpm build / pnpm build:portable 即可。'
  )
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': pathOf('src', 'shared')
      }
    },
    build: {
      rollupOptions: {
        // index.ts 用动态 require('./db') 等惰性加载核心模块（见 src/main/index.ts 的
        // loadCoreModules），Rollup 不会把动态 require 纳入单入口产物，必须把这些模块
        // 也列为入口，否则打包后 out/main 里只有 index.js，运行时报
        // "Cannot find module './db'" —— 表现为窗口标题「启动失败」。
        input: {
          index: pathOf('src', 'main', 'index.ts'),
          db: pathOf('src', 'main', 'db.ts'),
          search: pathOf('src', 'main', 'search.ts'),
          indexer: pathOf('src', 'main', 'indexer.ts'),
          watcher: pathOf('src', 'main', 'watcher.ts'),
          media: pathOf('src', 'main', 'media.ts'),
          datadir: pathOf('src', 'main', 'datadir.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': pathOf('src', 'shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: pathOf('src', 'preload', 'index.ts')
        }
      }
    }
  },
  renderer: {
    root: pathOf('src', 'renderer'),
    resolve: {
      alias: {
        '@renderer': pathOf('src', 'renderer', 'src'),
        '@shared': pathOf('src', 'shared')
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          index: pathOf('src', 'renderer', 'index.html')
        }
      }
    }
  }
})
