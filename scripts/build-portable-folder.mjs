/**
 * 把 electron-builder 的免安装目录版整理成可直接拷走的绿色版：
 *
 *   release\win-unpacked  →  release\WhichVideo-portable\
 *
 * 目录版没有解压环节，WhichVideo.exe 就地运行；主进程检测到 exe 所在目录可写时
 * 会把索引库与缓存写到同级的 data\ 里（见 src/main/datadir.ts）。
 *
 *   release\WhichVideo-portable  →  <仓库上一级目录>\WhichVideo-portable\
 *
 * 第二份放在仓库外面，是为了让"运行/验证"这件事彻底离开本项目目录：
 * 编辑器索引、杀软扫描、资源管理器停留都可能锁住仓库里的目录（见下面 EPERM 说明），
 * 而产物本身是要给用户双击运行的，放在项目里反而更容易被占用。
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
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
// 产物要再拷一份到仓库外面（默认是仓库上一级目录），让运行/验证不落在本项目里。
// WHICHVIDEO_OUTSIDE_DIR 给自检用，指向 tmp 里的目录，避免自检污染真实上一级目录。
const outsideRoot = process.env.WHICHVIDEO_OUTSIDE_DIR
  ? resolve(process.env.WHICHVIDEO_OUTSIDE_DIR)
  : resolve(root, '..')

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

/**
 * 递归统计文件数。
 *
 * excludeDirName：跳过这一层里叫这个名字的子目录。用于比对产物时排除
 * data\ —— 那是保留下来的用户索引库，源目录（release 里那份）本来就没有，
 * 算进去必然不一致。
 */
function countFiles(dir, excludeDirName) {
  let count = 0
  for (const entry of readdirSync(dir)) {
    if (excludeDirName && entry === excludeDirName) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) count += countFiles(full, excludeDirName)
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

/** 目录里所有普通文件的总字节数（用来核对拷贝是否完整） */
/** 递归统计目录占用字节；excludeDirName 的含义同 countFiles */
function directorySize(dir, excludeDirName) {
  let total = 0
  for (const entry of readdirSync(dir)) {
    if (excludeDirName && entry === excludeDirName) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) total += directorySize(full, excludeDirName)
    else total += st.size
  }
  return total
}

/** 单个文件的 sha256（核对拷贝后的产物是否与源一致） */
function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 把绿色版再拷一份到仓库外面（默认 <仓库上一级目录>\WhichVideo-portable）。
 *
 * 为什么要这一份：产物是给用户双击运行的，放在本项目目录里容易被编辑器索引、
 * 杀软扫描、资源管理器停留锁住（就是本文件顶部 EPERM 那段说的情况）。
 * 拷到仓库外再运行，"占用"和"验证"就跟项目目录彻底解耦。
 *
 * 占用处理与 release 里的目标目录完全一致：直接删 → 重试删 → 改名挪开 → 换带时间戳的目录。
 *
 * data\ 目录会被**保留**：里面是索引库（whichvideo.db）与用户自己的配置，
 * 重新建索引要重跑一遍抽帧，开发时反复打包很浪费时间。做法是先把 data\
 * 挪到临时位置，替换完产物再挪回去。若源目录（release 里那份）没有 data\
 * 则视为"要干净产物"，不保留。
 */
function copyOutsideRepository(sourceDir) {
  if (process.env.WHICHVIDEO_SKIP_OUTSIDE_COPY === '1') {
    return { skipped: true, dir: null }
  }

  // 沿用源目录名：release 里退到带时间戳的目录时，外面那份也带时间戳，两边不会认错
  const name = basename(sourceDir) || 'WhichVideo-portable'
  const preferred = join(outsideRoot, name)
  let dest = preferred

  // 旧目录里的 data\：先挪到 dest 的同级临时目录，替换完再挪回来
  let keptData = null
  let hasOldData = false

  if (existsSync(dest)) {
    // 和 clearTargetDirectory 一样尊重"强制占用"注入，否则自检没法覆盖被占用的分支
    const forcedLocked = process.env.WHICHVIDEO_TEST_FORCE_LOCKED === '1'
    const oldData = join(dest, 'data')
    hasOldData = existsSync(oldData)
    if (hasOldData && !forcedLocked) {
      // 挪走而不是复制：data 可能有几百 MB（索引库 + 缩略图），复制不划算，
      // 而且移动是原子的，不会出现"拷到一半失败"留下残缺 data 的情况。
      keptData = `${dest}.data-keep-${Date.now()}`
      try {
        renameSync(oldData, keptData)
      } catch {
        // 挪不动（跨卷、权限、data 被占用）就退回"删除"，下面的分支会如实告知
        keptData = null
      }
    }
    if (!forcedLocked) {
      try {
        rmSync(dest, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        /* 交给下面的重试与改名 */
      }
      if (!existsSync(dest) && hasOldData && !keptData) {
        console.log('  （旧的 data\\ 没能挪出来，已随目录一起清掉，需要时重新导入视频）')
      }
    }
    // data 挪出来了但目录本身删不掉：把 data 挪回去，别让索引库丢在临时路径上
    if (existsSync(dest) && keptData) {
      try {
        renameSync(keptData, join(dest, 'data'))
        keptData = null
      } catch {
        /* 下面会走改名挪开分支，data 留在临时路径上，最后再报告 */
      }
    }
    if (existsSync(dest)) {
      const removed = removeWithRetry(dest)
      if (!removed && existsSync(dest)) {
        console.log(`  仓库外的同名目录被占用，尝试改名挪开：${dest}`)
        const aside = moveAside(dest)
        if (aside) {
          console.log(`  已挪到 ${aside}（确认无用后可删除）`)
          removeWithRetry(aside, 3)
        } else {
          // 连改名都不行：换带时间戳的目录名继续，别让"外面那份正在运行"挡死打包
          dest = `${preferred}-${stamp()}`
          console.log(`  删除和改名都失败，改为输出到：${dest}`)
        }
      }
    }
  }

  try {
    mkdirSync(dest, { recursive: true })
    let copyError = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        cpSync(sourceDir, dest, { recursive: true, force: true })
        copyError = null
        break
      } catch (err) {
        copyError = err
        sleepSync(300 * (attempt + 1))
      }
    }
    if (copyError) throw copyError

    // 把保留的 data\ 挪回来。放在拷贝之后、校验之前 —— 校验要能把它算进去。
    let restoredData = false
    if (keptData) {
      try {
        renameSync(keptData, join(dest, 'data'))
        restoredData = true
        hasOldData = true
        keptData = null
      } catch (err) {
        return {
          skipped: false,
          dir: dest,
          error: `产物已拷贝，但旧的 data\\ 放不回来：${err instanceof Error ? err.message : String(err)}`,
          keptDataPath: keptData
        }
      }
    }

    // 核对：exe 在、文件数与总字节数一致、asar 与源同 hash。
    // 拷贝被中途打断时常常"看起来成功"，少几个文件的情况必须在这里挡住。
    // data\ 是唯一允许与源不一致的部分（源没有、目标有），所以比文件数与字节数时排除它。
    const srcAsar = join(sourceDir, 'resources', 'app.asar')
    const dstAsar = join(dest, 'resources', 'app.asar')
    const problems = []
    if (!existsSync(join(dest, 'WhichVideo.exe'))) problems.push('缺少 WhichVideo.exe')
    if (existsSync(srcAsar) && existsSync(dstAsar) && hashFile(srcAsar) !== hashFile(dstAsar)) {
      problems.push('app.asar 与源不一致')
    }
    const srcFiles = countFiles(sourceDir)
    const dstFiles = countFiles(dest, 'data')
    if (srcFiles !== dstFiles) problems.push(`文件数不一致（源 ${srcFiles} / 目标 ${dstFiles}）`)
    const srcBytes = directorySize(sourceDir)
    const dstBytes = directorySize(dest, 'data')
    if (srcBytes !== dstBytes) problems.push(`总字节数不一致（源 ${srcBytes} / 目标 ${dstBytes}）`)
    if (problems.length > 0) {
      return { skipped: false, dir: dest, error: `拷贝校验不通过：${problems.join('；')}` }
    }

    return {
      skipped: false,
      dir: dest,
      fallback: dest !== preferred,
      fileCount: dstFiles,
      bytes: dstBytes,
      dataPreserved: restoredData || hasOldData
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      skipped: false,
      dir: dest,
      error: keptData ? `${msg}（另外：旧的 data\\ 还在 ${keptData}，请手动挪回去）` : msg,
      keptDataPath: keptData
    }
  }
}

/**
 * 确认编译产物齐全。
 * 打包前必须检查：electron-builder 会把 out/ 原样塞进 asar，
 * 一旦 out/ 缺文件（构建没跑完/被中断），打出来的应用就会"双击没反应"且没有任何日志——
 * 因为主进程 JS 压根没跑起来。
 */
function assertBuildOutput() {
  // 默认校验发布产物 out/；自检可用 WHICHVIDEO_BUILD_DIR 指向 tsc 产物（结构一致）
  const buildDir = process.env.WHICHVIDEO_BUILD_DIR
    ? resolve(process.env.WHICHVIDEO_BUILD_DIR)
    : join(root, 'out')
  const required = [
    ['主进程', join(buildDir, 'main', 'index.js')],
    ['渲染页面', join(buildDir, 'renderer', 'index.html')],
    [
      'preload',
      [join(buildDir, 'preload', 'index.mjs'), join(buildDir, 'preload', 'index.js')].find((p) =>
        existsSync(p)
      ) ?? join(buildDir, 'preload', 'index.mjs')
    ],
    // 惰性加载的核心模块必须都在：漏了就是一个"运行到某功能才炸"的坑。
    // （入口由 electron.vite.config.ts 扫描 src/main 自动生成，这里再兜一层）
    ...readdirSync(join(root, 'src', 'main'))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
      .map((f) => [`核心模块 ${f}`, join(buildDir, 'main', f.replace(/\.ts$/, '.js'))])
  ]
  const missing = required.filter(([, file]) => !existsSync(file))
  if (missing.length === 0) {
    for (const [label, file] of required.slice(0, 3)) {
      console.log(`  ✓ 编译产物就绪：${label}（${relative(root, file)}）`)
    }
    console.log(`  ✓ 编译产物就绪：核心模块共 ${required.length - 3} 个（${relative(root, buildDir)} 下均有对应 .js）`)
    return
  }
  const missingList = missing.map(([label, file]) => `${label}: ${relative(root, file)}`)
  console.error('\n编译产物不完整，不能打包：')
  for (const item of missingList) console.error(`  ✗ 缺少 ${item}`)
  console.error('\n先执行完整构建再打包：')
  console.error('  pnpm build          # typecheck + electron-vite build（产出 out/）')
  console.error('  pnpm build:portable # 已经包含上一步，请确认它没有中途失败')
  writeTestReport({ ok: false, reason: 'missing-build-output', missing: missingList })
  process.exit(1)
}

/**
 * 用 electron-builder 产出 win-unpacked。
 *
 * 关键点：**每次都重新打包**，并且校验生成的 app.asar 确实比 out/ 新。
 * 之前的版本看到 win-unpacked 里已有 WhichVideo.exe 就跳过打包，
 * 结果 electron-builder 那次失败后（例如它内部的 @electron/rebuild 报错），
 * 脚本仍然拿旧目录做出一个"看起来正常"的绿色版 —— 装的是旧代码。
 */
function runElectronBuilder() {
  const packedAsar = join(unpackedDir, 'resources', 'app.asar')
  const outMain = join(root, 'out', 'main', 'index.js')
  const outMtime = statSync(outMain).mtimeMs
  const staleBefore = !existsSync(packedAsar) || statSync(packedAsar).mtimeMs < outMtime

  console.log('运行 electron-builder（--win dir）…')
  const r = spawnSync(
    process.execPath,
    [join(root, 'node_modules', 'electron-builder', 'cli.js'), '--win', 'dir'],
    { stdio: 'inherit', cwd: root }
  )
  if (r.status !== 0) {
    // 不直接退出：有些环境里 electron-builder 会在"重建原生模块"阶段失败，
    // 但产物其实已经写完。用时间戳判断到底有没有生成新包。
    console.log(`\n  ⚠ electron-builder 退出码为 ${r.status}，检查产物是否已更新…`)
  }

  if (!existsSync(join(unpackedDir, 'WhichVideo.exe'))) {
    console.error(`\n打包失败：没有生成 ${join(unpackedDir, 'WhichVideo.exe')}`)
    console.error('常见原因：electron-builder 在 iOS/原生模块重建阶段中断（spawn EPERM 等）。')
    console.error('可尝试： pnpm rebuild:native  或手动执行 npx electron-builder --win dir')
    writeTestReport({ ok: false, reason: 'electron-builder-failed', exitCode: r.status })
    process.exit(1)
  }

  const fresh = existsSync(packedAsar) && statSync(packedAsar).mtimeMs >= outMtime
  if (!fresh) {
    console.error('\n打包结果不新鲜：app.asar 比 out/ 里的产物旧，说明这次没有真正重新打包。')
    console.error(
      `  out/main/index.js      ${new Date(outMtime).toLocaleString('zh-CN')}\n` +
        `  resources/app.asar     ${existsSync(packedAsar) ? new Date(statSync(packedAsar).mtimeMs).toLocaleString('zh-CN') : '不存在'}`
    )
    console.error('处理：删掉 release\\win-unpacked 后重跑，或查看上面的 electron-builder 报错。')
    writeTestReport({ ok: false, reason: 'stale-package', exitCode: r.status })
    process.exit(1)
  }

  console.log(`  ✓ 本次打包产物已更新（app.asar ${new Date(statSync(packedAsar).mtimeMs).toLocaleString('zh-CN')}）`)
  void staleBefore
  assertPackageFreshness()
}

/**
 * 读取 asar 里的文件内容。
 *
 * 重要教训：手写 pickle 解析曾经把内容起点算错 1 个字节，
 * 导致"包内产物与本地不一致"的误报，浪费了排查时间。
 * 因此一律使用 electron-builder 自带的 @electron/asar 做整体解包后再读文件；
 * 只有它完全不可用时，才退回手写解析（结果仅作参考）。
 */
function extractAsar(asarPath, destDir) {
  const require = createRequire(import.meta.url)
  const candidates = []
  try {
    candidates.push(require.resolve('@electron/asar'))
  } catch {
    /* 顶层没有就找 pnpm 虚拟 store */
  }
  const store = join(root, 'node_modules', '.pnpm')
  if (existsSync(store)) {
    for (const dir of readdirSync(store)) {
      if (!dir.startsWith('@electron+asar@')) continue
      candidates.push(join(store, dir, 'node_modules', '@electron', 'asar', 'lib', 'asar.js'))
    }
  }
  const found = candidates.find((p) => existsSync(p))
  if (!found) return false
  const asar = require(found)
  rmSync(destDir, { recursive: true, force: true })
  mkdirSync(destDir, { recursive: true })
  asar.extractAll(asarPath, destDir)
  return true
}

/** 读取 asar 中某个文件的内容（优先官方库整体解包） */
function readAsarEntry(asarPath, entryPath) {
  const dest = join(root, 'tmp', 'asar-read')
  try {
    if (extractAsar(asarPath, dest)) {
      const file = join(dest, entryPath.replace(/^\//, ''))
      return existsSync(file) ? readFileSync(file) : null
    }
    console.log('  （未找到 @electron/asar，改用内置解析；结果仅作参考）')
  } catch (err) {
    console.log(`  （@electron/asar 解包失败：${err instanceof Error ? err.message : String(err)}，改用内置解析）`)
  }
  return readAsarEntryManually(asarPath, entryPath)
}

/**
 * 手写 asar 解析（兜底）。
 * 头部布局：[0..3] 外层 pickle payload 长度；[4..7] 内层 payload 长度 = 4 + json 长度；
 * [8..11] = json 长度；[12..] json；内容起点 = 12 + json 长度。
 */
function readAsarEntryManually(asarPath, entryPath) {
  const buf = readFileSync(asarPath)
  const jsonSize = buf.readUInt32LE(8)
  const header = JSON.parse(buf.subarray(12, 12 + jsonSize).toString('utf8'))
  const parts = entryPath.replace(/^\//, '').split('/')
  let node = header
  for (const part of parts) {
    node = node?.files?.[part]
    if (!node) return null
  }
  const start = 12 + jsonSize + Number(node.offset)
  const inBounds = start >= 0 && Number(node.size) >= 0 && start + Number(node.size) <= buf.length
  if (!inBounds) {
    console.log(`  （内置解析越界，放弃：${entryPath}）`)
    return null
  }
  return buf.subarray(start, start + Number(node.size))
}

/**
 * 校验打出来的包确实是这次的代码。
 * 用 sha256 直接比对包内 out/main/index.js 与本地编译产物 —— 字节级一致才算新鲜。
 */
function assertPackageFreshness() {
  const packedAsar = join(unpackedDir, 'resources', 'app.asar')
  if (!existsSync(packedAsar)) {
    console.error(`\n打包失败：没有生成 ${packedAsar}`)
    writeTestReport({ ok: false, reason: 'asar-missing' })
    process.exit(1)
  }

  const mainInAsar = readAsarEntry(packedAsar, 'out/main/index.js')
  if (!mainInAsar) {
    console.error('\n打包结果异常：asar 里没有 out/main/index.js')
    writeTestReport({ ok: false, reason: 'asar-missing-main' })
    process.exit(1)
  }

  const localMain = readFileSync(join(root, 'out', 'main', 'index.js'))
  const packedHash = createHash('sha256').update(mainInAsar).digest('hex')
  const localHash = createHash('sha256').update(localMain).digest('hex')
  if (packedHash !== localHash) {
    console.error('\n包内主进程产物与 out/ 不一致，说明这次没有真正重新打包：')
    console.error(`  包内 sha256 ${packedHash}（${mainInAsar.length} 字节）`)
    console.error(`  本地 sha256 ${localHash}（${localMain.length} 字节）`)
    console.error('\n处理：删掉 release\\win-unpacked 与 release\\WhichVideo-portable 后重跑。')
    writeTestReport({ ok: false, reason: 'stale-package', packedHash, localHash })
    process.exit(1)
  }

  console.log(`  ✓ 已校验包内 out/main/index.js 与本次编译产物字节一致（sha256 ${localHash.slice(0, 12)}…）`)
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

  const skipBuildCheck = process.env.WHICHVIDEO_SKIP_BUILD_CHECK === '1'
  // 注意：不要加 existsSync(out) 之类的短路条件。
  // 之前写成"out 存在才检查"，结果 out 整个缺失时反而跳过校验直接打包，
  // 正好漏掉最该拦住的那种情况（自检场景 4 就是为了防这个）。
  if (!skipBuildCheck) {
    assertBuildOutput()
  }

  // 每次都重新打包并校验新鲜度（旧版本会因为目录里已有 exe 而跳过，导致发布旧代码）
  const skipPack = process.env.WHICHVIDEO_SKIP_ELECTRON_BUILDER === '1'
  if (!skipPack) {
    runElectronBuilder()
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

  // 再拷一份到仓库外面，方便直接运行验证（不落在本项目目录里，避免被索引/杀软锁住）
  console.log(`\n正在拷贝一份到仓库外：${outsideRoot}`)
  const outside = copyOutsideRepository(targetDir)
  if (outside.skipped) {
    console.log('  （已通过 WHICHVIDEO_SKIP_OUTSIDE_COPY 跳过）')
  } else if (outside.error) {
    // 不让这一份的失败把整次打包判死：release 里的产物已经是好的。
    // 但必须显眼地报出来，并给出下一步该做什么。
    console.error('\n⚠ 拷贝到仓库外失败（release 里的绿色版仍然可用）：')
    console.error(`  原因：${outside.error}`)
    console.error(`  目标位置：${outside.dir ?? join(outsideRoot, 'WhichVideo-portable')}`)
    console.error('  处理：手动拷走 release\\WhichVideo-portable 即可；或先关掉正在运行的绿色版再重试。')
  } else {
    console.log(`  ✓ 仓库外副本已就绪：${outside.dir}`)
    console.log(`    文件数量：${outside.fileCount}（${(outside.bytes / 1024 / 1024).toFixed(1)} MB，与源一致）`)
    if (outside.dataPreserved) {
      console.log('    已保留原有的 data\\（索引库与配置），不需要重新导入视频。')
    }
    if (outside.fallback) console.log('    注意：同名目录被占用，本次用了带时间戳的新目录。')
    console.log(`    直接运行：${join(outside.dir, 'WhichVideo.exe')}`)
  }

  writeTestReport({
    ok: true,
    reason: targetDir === preferredTargetDir ? 'built' : 'built-fallback',
    targetDir,
    preferredTargetDir,
    fileCount,
    outsideRoot,
    outsideDir: outside.dir ?? null,
    outsideError: outside.error ?? null,
    outsideSkipped: outside.skipped === true
  })
}

/**
 * 供自检复用的内部函数（正常打包不会用到导出）。
 */
export { readAsarEntry, readAsarEntryManually, assertPackageFreshness, runElectronBuilder }

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isDirectRun) {
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
}
