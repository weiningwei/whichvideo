/**
 * 把 electron-builder 的免安装目录版整理成可直接拷走的绿色版：
 *
 *   release\win-unpacked  →  release\WhichVideo-portable\
 *
 * 目录版没有解压环节，WhichVideo.exe 就地运行；主进程检测到 exe 所在目录可写时
 * 会把索引库与缓存写到同级的 data\ 里（见 src/main/datadir.ts）。
 *
 * 运行： node scripts/build-portable-folder.mjs
 */
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const releaseDir = join(root, 'release')
const unpackedDir = join(releaseDir, 'win-unpacked')
const targetDir = join(releaseDir, 'WhichVideo-portable')

function countFiles(dir) {
  let count = 0
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) count += countFiles(full)
    else count++
  }
  return count
}

function main() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

  if (!existsSync(join(unpackedDir, 'WhichVideo.exe'))) {
    console.log('未找到 release/win-unpacked，先执行 electron-builder --win dir …')
    const r = spawnSync(
      process.execPath,
      [join(root, 'node_modules', 'electron-builder', 'cli.js'), '--win', 'dir'],
      { stdio: 'inherit', cwd: root }
    )
    if (r.status !== 0) throw new Error('electron-builder 打包失败')
  }

  if (!existsSync(join(unpackedDir, 'WhichVideo.exe'))) {
    throw new Error(`打包结果里没有 WhichVideo.exe：${unpackedDir}`)
  }

  rmSync(targetDir, { recursive: true, force: true })
  cpSync(unpackedDir, targetDir, { recursive: true })

  // 放一份说明，避免用户把 data 目录当垃圾清掉
  writeFileSync(
    join(targetDir, '便携版说明.txt'),
    [
      `WhichVideo ${pkg.version} · 免安装绿色版`,
      '',
      '1. 双击 WhichVideo.exe 直接运行，无需安装，也没有解压过程。',
      '2. 首次运行会在本目录下创建 data\\ 子目录，索引库与缓存都存在那里。',
      '   迁移时把整个文件夹拷走即可，不会在系统盘留下任何东西。',
      '3. 请勿把本文件夹放到 Program Files 等只读位置，否则数据会退回',
      '   %APPDATA%\\WhichVideo（界面的「索引设置」里可以看到实际位置）。',
      '4. 想固定数据位置：set WHICHVIDEO_DATA_DIR=E:\\WhichVideoData 后再启动。',
      '5. 需要 ffmpeg 时，可把 ffmpeg.exe / ffprobe.exe 放到本目录或 data\\bin\\ 下。',
      ''
    ].join('\r\n'),
    'utf8'
  )

  console.log(`\n绿色版目录已就绪：${targetDir}`)
  console.log(`  可执行文件：${join(targetDir, 'WhichVideo.exe')}`)
  console.log(`  文件数量：${countFiles(targetDir)}`)
  console.log('  拷走整个文件夹即可迁移；运行后会自动生成 data\\ 子目录。')
}

try {
  main()
} catch (err) {
  console.error(`\n构建绿色版失败：${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
