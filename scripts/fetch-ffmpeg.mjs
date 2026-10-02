#!/usr/bin/env node
/**
 * 下载 ffmpeg / ffprobe 到 resources/bin（Windows x64 静态构建）。
 *
 * 用法：
 *   node scripts/fetch-ffmpeg.mjs
 *
 * 打包时 electron-builder 会把 resources/bin 复制到安装目录的 resources/bin，
 * 主进程启动时优先从这里加载，因此终端用户不需要自己装 ffmpeg。
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, 'resources', 'bin')

const DOWNLOAD_URL =
  process.env.FFMPEG_URL ?? 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'

async function download(url, target) {
  console.log(`下载 ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`下载失败：HTTP ${response.status}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target))
  console.log(`已保存到 ${target}`)
}

function extract(zipPath, destDir) {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`
    ],
    { stdio: 'inherit' }
  )
}

/** 递归查找文件名匹配的所有文件（不关心目录层级） */
function findFiles(dir, wanted) {
  const found = []
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of readdirSync(current)) {
      const full = join(current, entry)
      const st = statSync(full)
      if (st.isDirectory()) {
        stack.push(full)
      } else if (wanted.some((name) => entry.toLowerCase() === name)) {
        found.push(full)
      }
    }
  }
  return found
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('该脚本只处理 Windows 构建；其他平台请用系统包管理器安装 ffmpeg。')
    return
  }
  mkdirSync(outDir, { recursive: true })
  if (existsSync(join(outDir, 'ffmpeg.exe')) && existsSync(join(outDir, 'ffprobe.exe'))) {
    console.log('resources/bin 下已存在 ffmpeg.exe 与 ffprobe.exe，跳过。')
    return
  }

  const tmpDir = join(root, 'tmp', 'ffmpeg-download')
  mkdirSync(tmpDir, { recursive: true })
  const zipPath = join(tmpDir, 'ffmpeg.zip')
  await download(DOWNLOAD_URL, zipPath)

  const unpackDir = join(tmpDir, 'unpack')
  rmSync(unpackDir, { recursive: true, force: true })
  mkdirSync(unpackDir, { recursive: true })
  extract(zipPath, unpackDir)

  const binaries = findFiles(unpackDir, ['ffmpeg.exe', 'ffprobe.exe'])
  if (binaries.length < 2) {
    throw new Error(`压缩包里没有找到 ffmpeg.exe / ffprobe.exe（找到 ${binaries.length} 个）`)
  }
  for (const source of binaries) {
    const target = join(outDir, source.slice(source.lastIndexOf('\\') + 1))
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Copy-Item -LiteralPath '${source}' -Destination '${target}' -Force`], {
      stdio: 'inherit'
    })
    console.log(`已就位 ${target}`)
  }

  rmSync(tmpDir, { recursive: true, force: true })
  console.log('完成。')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
