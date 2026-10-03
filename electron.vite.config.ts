import { existsSync, readdirSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
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

/**
 * 自动收集主进程入口，**不要**改回手写列表。
 *
 * 为什么：src/main/index.ts 用 `require('./db')` 这类字面量惰性加载核心模块
 * （为了捕获原生模块加载失败并落日志）。Rollup 单入口构建不会把这些文件纳入产物，
 * 于是 out/main 里只有 index.js，运行时报 "Cannot find module './db'"，
 * 表现为窗口标题「启动失败」。
 *
 * 历史教训：这里曾经是手写的 7 个入口列表，新增 src/main/xxx.ts 后必然漏掉，
 * 而且是**运行时才暴露**（构建不报错）。改成扫描整个目录后，新增文件自动纳入。
 * 配套还有 scripts/test-build-output.mjs 做构建后校验，双重兜底。
 */
function mainEntries(): Record<string, string> {
  const dir = pathOf('src', 'main')
  const entries: Record<string, string> = {}
  for (const file of readdirSync(dir)) {
    if (extname(file) !== '.ts') continue
    if (file.endsWith('.d.ts')) continue
    entries[basename(file, '.ts')] = resolve(dir, file)
  }
  if (!entries.index) {
    throw new Error(`src/main 下没有找到 index.ts（目录：${dir}）`)
  }
  return entries
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
        input: mainEntries(),
        output: {
          // 关键：主进程产物必须"一个模块一个文件"。
          //
          // 为什么不能用默认的打包方式：
          // 1) 多入口时 Rollup 会把共享模块**复制**进每个入口。logger.ts 里有模块级状态
          //    （初始化前先缓冲日志的 pending 数组），被复制成多份后，index.js 里的
          //    bootstrapLogger() 与后续 relocateLogger() 可能操作到不同实例，
          //    表现为"早期日志莫名其妙丢失"——构建不报错，只在运行时显现。
          // 2) logger.ts / scan.ts 这类文件若不是入口，会被内联进 index.js；
          //    一旦入口列表漏了某个文件，运行时才报 Cannot find module（历史上就漏过）。
          // preserveModules 让 out/main 与 src/main 一一对应，require('./x') 稳定命中同名文件。
          preserveModules: true,
          preserveModulesRoot: pathOf('src', 'main'),
          entryFileNames: '[name].js'
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
