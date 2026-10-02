/**
 * 把 electron-builder 的免安装目录版整理成可直接拷走的绿色版：
 *
 *   release\win-unpacked  →  release\WhichVideo-portable\
 *
 * 目录版没有解压环节，WhichVideo.exe 就地运行；主进程检测到 exe 所在目录可写时
 * 会把索引库与缓存写到同级的 data\ 里（见 src/main/datadir.ts）。
 *
 * 运行： node scripts/build-portable-folder.mjs
 *
 * 关于 EPERM：绿色版运行时 exe 会被占用，资源管理器停在该目录、杀毒软件扫描
 * 刚生成的二进制也会短暂占用。所以这里不硬删目录，而是：
 *   重试删除 → 重命名成 .old-<时间戳> 挪开 → 都不行才报错并给出可操作提示。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const argv = process.argv.slice(2)
// WHICHVIDEO_RELEASE_DIR 主要给自检用（scripts/test-portable-builder.mjs），正常打包不需要设置
const releaseDir = process.env.WHICHVIDEO_RELEASE_DIR
  ? resolve(process.env.WHICHVIDEO_RELEASE_DIR)
  : join(root, 'release')
const unpackedDir = join(releaseDir, 'win-unpacked')
const preferredTargetDir = join(releaseDir, 'WhichVideo-portable')
// 首选目录被占用时，会自动退到这个带时间的目录继续打包（见 clearTargetDirectory）
let targetDir = preferredTargetDir

const sleepSync = (ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    /* 忙等：打包脚本不需要精细调度 */
  }
}

/** 带重试的删除（Windows 上文件刚被释放时常见瞬时占用） */
function removeWithRetry(dir, attempts = 5) {
  // 自检用：模拟"目录被占用，删也删不掉"（scripts/test-portable-builder.mjs）
  if (process.env.WHICHVIDEO_TEST_FORCE_LOCKED === '1') return false
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      return true
    } catch {
      sleepSync(200 * (i + 1))
    }
  }
  return false
}

/** 判断目录能否直接删除（用重命名试探，能改名就一定能删） */
function moveAside(dir) {
  if (process.env.WHICHVIDEO_TEST_FORCE_LOCKED === '1') return null
  const aside = `${dir}.old-${Date.now()}`
  try {
    renameSync(dir, aside)
    return aside
  } catch {
    return null
  }
}

function countFiles(dir) {
  let count = 0
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) count += countFiles(full)
    else count++
  }
  return count
}

/** 提示可能是哪个进程占用了目录（探测失败也不能影响报错信息） */
function describeHolders(dir) {
  const hints = []

  // 用 PEB 读出每个进程的当前工作目录：CWD 停在该目录（或其上级）是 Windows 上
  // 最常见的"目录既删不掉也改不了名"的原因，而且和进程 exe 在哪无关。
  try {
    const script = join(root, 'scripts', 'lib', 'who-locks-dir.ps1')
    if (existsSync(script)) {
      const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
      const r = spawnSync(
        shell,
        [
          '-NoProfile',
          '-NonInteractive',
          // 本机执行策略可能禁止运行未签名脚本，这里只针对我们自己的诊断脚本放行
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-Path',
          dir,
          '-Brief'
        ],
        { encoding: 'utf8', timeout: 25000, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      const line = String(r.stdout ?? '')
        .split(/\r?\n/)
        .find((l) => l.startsWith('HOLDERS'))
      if (line && !line.includes('无直接命中')) {
        hints.push(line.replace(/^HOLDERS\s*/, '检测到占用线索 → '))
      }
    }
  } catch {
    /* 探测失败就只给通用提示 */
  }

  try {
    const r = spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq WhichVideo.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    if (!r.error && r.status === 0 && /WhichVideo\.exe/i.test(String(r.stdout))) {
      hints.push('检测到 WhichVideo.exe 正在运行 —— 请先退出应用再重新打包')
    }
  } catch {
    /* 受限环境可能不允许启动子进程，忽略即可 */
  }

  hints.push('编辑器（Sublime 的 plugin_host、VS Code 等）在索引本项目时会占用目录 —— 退出或关掉该项目窗口')
  hints.push(`资源管理器可能停在该目录 —— 换个目录再看（当前：${dir}）`)
  hints.push('杀毒软件/Defender 可能正在扫描刚生成的 exe —— 稍等十几秒重试')
  return hints
}

/**
 * 诊断当前占有目录的进程（供手动排查）：
 *   node scripts/build-portable-folder.mjs --who-locks release\WhichVideo-portable
 */
function runWhoLocks(dir) {
  const script = join(root, 'scripts', 'lib', 'who-locks-dir.ps1')
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
  console.log(`诊断目录占用：${dir}\n`)
  const r = spawnSync(
    shell,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', dir, '-All'],
    { stdio: 'inherit' }
  )
  process.exit(r.status ?? 1)
}

/**
 * 自检用的结构化输出（仅当设置了 WHICHVIDEO_TEST_REPORT 时写，
 * 因为受限环境可能抓不到子进程的 stdout）。
 */
function writeTestReport(report) {
  const target = process.env.WHICHVIDEO_TEST_REPORT
  if (!target) return
  try {
    writeFileSync(target, JSON.stringify(report, null, 2), 'utf8')
  } catch {
    /* 自检辅助，失败无所谓 */
  }
}

/**
 * 清空目标目录。
 * 顺序：直接删 → 带重试删 → 改名成 .old-<时间戳> 挪开 → 仍然不行就换一个输出目录继续。
 *
 * 换目录这条路是为了不让"某个程序恰好占着这个目录"（例如编辑器在索引本项目）挡死打包：
 * 目标目录本来就是要被我们写入的，换个名字照样是干净的产物。
 * （自检用 WHICHVIDEO_TEST_FORCE_LOCKED 模拟"删不掉且改不了名"）
 */
function clearTargetDirectory() {
  const forcedLocked = process.env.WHICHVIDEO_TEST_FORCE_LOCKED === '1'
  if (!existsSync(targetDir)) return

  if (!forcedLocked) {
    try {
      rmSync(targetDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      /* 交给下面的重试与改名 */
    }
    if (!existsSync(targetDir)) return
  }

  const removed = removeWithRetry(targetDir)
  if (removed || !existsSync(targetDir)) return

  console.log(`  目标目录被占用，尝试改名挪开：${targetDir}`)
  const aside = moveAside(targetDir)
  if (aside) {
    console.log(`  已挪到 ${aside}（确认无用后可删除）`)
    removeWithRetry(aside, 3)
    return
  }

  // 连改名都不行：换一个输出目录，让打包继续下去
  const fallback = `${preferredTargetDir}-${stamp()}`
  console.log('')
  console.log('  ⚠ 目标目录被占用，删除和改名都失败，改为输出到新目录：')
  console.log(`     ${fallback}`)
  for (const hint of describeHolders(preferredTargetDir)) console.log(`     · ${hint}`)
  console.log('')
  targetDir = fallback
  rmSync(targetDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  mkdirSync(targetDir, { recursive: true })
}

/** 形如 20261003-0217，用于回退目录名 */
function stamp() {
  const d = new Date()
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

function main() {
  // 手动排查入口：诊断某个目录被谁占用
  const whoIndex = argv.indexOf('--who-locks')
  if (whoIndex >= 0) {
    const target = argv[whoIndex + 1] ?? preferredTargetDir
    runWhoLocks(resolve(target))
    return
  }

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

  // 清空目标目录：直接删 → 重试 → 改名挪开 → 报错并给出可操作提示
  clearTargetDirectory()

  mkdirSync(targetDir, { recursive: true })
  // 复制也做重试：刚写完的产物可能被杀软/索引服务短暂占用
  let copyError = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      cpSync(unpackedDir, targetDir, { recursive: true })
      copyError = null
      break
    } catch (err) {
      copyError = err
      sleepSync(300 * (attempt + 1))
    }
  }
  if (copyError) throw copyError

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
      '6. 重新打包前请先退出正在运行的 WhichVideo.exe，否则目录被占用会打包失败。',
      ''
    ].join('\r\n'),
    'utf8'
  )

  console.log(`\n绿色版目录已就绪：${targetDir}`)
  console.log(`  可执行文件：${join(targetDir, 'WhichVideo.exe')}`)
  const fileCount = countFiles(targetDir)
  console.log(`  文件数量：${fileCount}`)
  console.log('  拷走整个文件夹即可迁移；运行后会自动生成 data\\ 子目录。')
  writeTestReport({
    ok: true,
    reason: targetDir === preferredTargetDir ? 'built' : 'built-fallback',
    targetDir,
    preferredTargetDir,
    fileCount
  })
}

try {
  main()
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  if (/EPERM|EBUSY|ENOTEMPTY|resource busy|being used by another process/i.test(message)) {
    const hints = describeHolders(targetDir)
    const lines = [
      '',
      '打包失败：release 目录里的文件被占用（EPERM）。',
      ...hints.map((hint) => `  · ${hint}`),
      '',
      '处理完占用后重新运行： pnpm build:portable'
    ]
    console.error(lines.join('\n'))
    console.log(`BUILD_LOCKED ${targetDir}`)
    writeTestReport({ ok: false, reason: 'copy-locked', error: message, hints })
  } else {
    console.error(`\n构建绿色版失败：${message}`)
    writeTestReport({ ok: false, reason: 'error', error: message })
  }
  process.exit(1)
}
