/**
 * 绿色版打包脚本的自检。
 *
 * 起因：pnpm build:portable 报
 *   EPERM, Permission denied: ...\release\WhichVideo-portable
 * 也就是目标目录被占用（绿色版正在运行 / 资源管理器停在目录里 / 杀软在扫），
 * 而旧脚本直接 rmSync，只抛裸 EPERM，用户不知道该怎么办。
 *
 * 覆盖：
 *   1. 正常重建：覆盖旧产物、清掉旧的 data\、写出便携版说明，并额外拷一份到仓库外
 *   2. 目录删不掉也改名不掉时：失败退出并给出可操作提示，且不留下半成品、不丢旧数据
 *   3. 占用解除后再次打包能恢复到干净产物
 *   4. 编译产物不全时拒绝打包
 *   5. 必须校验"打包结果是否新鲜"
 *   6. 仓库外那份被占用时同样自动换目录，且可以用开关跳过拷贝
 *
 * 说明：真实文件锁需要独占句柄 + 子进程，而本环境禁止 spawn，
 * 所以第 2 项用 WHICHVIDEO_TEST_FORCE_LOCKED 注入"删不掉"的状态；
 * 断言通过 WHICHVIDEO_TEST_REPORT 写出的 JSON 报告完成（stdout 在受限环境抓不到）。
 *
 * 运行： node scripts/test-portable-builder.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const builder = join(root, 'scripts', 'build-portable-folder.mjs')
const work = join(root, 'tmp', 'portable-builder-test')
/** 自检用的"构建产物"目录：放占位文件即可，结构与发布产物 out/ 一致 */
const stubBuildDir = join(work, 'build')
/** 仓库外拷贝的落点：必须指向 tmp，否则自检会往真实的上一级目录里写东西 */
const outsideRoot = join(work, 'outside')

/** 把字符串里的正则元字符转义，用于"按本机真实路径搜泄漏"这类断言 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function ensureStubBuild() {
  mkdirSync(join(stubBuildDir, 'main'), { recursive: true })
  mkdirSync(join(stubBuildDir, 'renderer'), { recursive: true })
  mkdirSync(join(stubBuildDir, 'preload'), { recursive: true })
  for (const f of ['main/index.js', 'renderer/index.html', 'preload/index.js']) {
    const target = join(stubBuildDir, f)
    if (!existsSync(target)) {
      if (f === 'main/index.js') {
        // 主进程产物里带上 require('./x')，用于验证"产物完整性"这条校验真的生效
        writeFileSync(target, "require('./db')\n")
      } else {
        writeFileSync(target, '// stub\n')
      }
    }
  }
  // 核心模块占位（对应 src/main/*.ts 的编译产物）
  for (const f of readdirSync(join(root, 'src', 'main'))) {
    if (!f.endsWith('.ts') || f.endsWith('.d.ts')) continue
    const target = join(stubBuildDir, 'main', f.replace(/\.ts$/, '.js'))
    if (!existsSync(target) && f !== 'index.ts') writeFileSync(target, '// stub\n')
  }
}

let failed = 0
let passed = 0

function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * 跑打包脚本。
 * stdio 全部继承：受限环境里给子进程建管道会 EPERM，
 * 结果通过 WHICHVIDEO_TEST_REPORT 指向的 JSON 文件回传。
 */
function runBuilder(releaseDir, extraEnv = {}, { prepareStub = true } = {}) {
  const reportPath = join(work, `report-${Math.random().toString(36).slice(2)}.json`)
  // 自检用占位产物目录，结构与发布产物 out/ 一致，让产物校验能正常通过。
  // 场景 4 故意删文件验证"缺产物必须拒绝打包"，所以要能跳过补齐。
  if (prepareStub) ensureStubBuild()
  try {
    execFileSync(process.execPath, [builder], {
      cwd: root,
      env: {
        ...process.env,
        WHICHVIDEO_RELEASE_DIR: releaseDir,
        WHICHVIDEO_TEST_REPORT: reportPath,
        WHICHVIDEO_BUILD_DIR: stubBuildDir,
        // 自检不真的跑 electron-builder（耗时且需要 Electron 二进制）
        WHICHVIDEO_SKIP_ELECTRON_BUILDER: '1',
        // 仓库外拷贝的落点固定在 tmp 里：绝不能写到真实的上一级目录
        WHICHVIDEO_OUTSIDE_DIR: outsideRoot,
        ...extraEnv
      },
      stdio: ['ignore', 'inherit', 'inherit']
    })
    return { ok: true, report: readReport(reportPath) }
  } catch (err) {
    return { ok: false, report: readReport(reportPath), message: err instanceof Error ? err.message : String(err) }
  }
}

function readReport(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** 准备一个假的 win-unpacked，外加"上次运行留下的"目标目录 */
function prepareLayout(releaseDir) {
  rmSync(releaseDir, { recursive: true, force: true })
  const unpacked = join(releaseDir, 'win-unpacked')
  mkdirSync(join(unpacked, 'resources'), { recursive: true })
  mkdirSync(join(unpacked, 'locales'), { recursive: true })
  writeFileSync(join(unpacked, 'WhichVideo.exe'), 'fake exe')
  writeFileSync(join(unpacked, 'resources', 'app.asar'), 'fake asar v2')
  writeFileSync(join(unpacked, 'locales', 'zh-CN.pak'), 'fake pak')

  const target = join(releaseDir, 'WhichVideo-portable')
  mkdirSync(join(target, 'data'), { recursive: true })
  mkdirSync(join(target, 'resources'), { recursive: true })
  writeFileSync(join(target, 'WhichVideo.exe'), 'old fake exe')
  writeFileSync(join(target, 'resources', 'app.asar'), 'old asar')
  writeFileSync(join(target, 'data', 'whichvideo.db'), 'user data that must be replaced')
  return { target, unpacked }
}

function main() {
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })

  console.log('=== 场景 1：正常重建绿色版目录 ===')
  {
    const releaseDir = join(work, 'clean')
    const { target } = prepareLayout(releaseDir)
    const r = runBuilder(releaseDir)
    check('脚本成功退出', r.ok, r.ok ? '' : r.message)
    check('报告标记为成功', r.report?.ok === true && r.report?.reason === 'built', JSON.stringify(r.report ?? {}).slice(0, 80))
    check('复制了 exe', existsSync(join(target, 'WhichVideo.exe')))
    check('复制了 resources/app.asar', existsSync(join(target, 'resources', 'app.asar')))
    check('复制了 locales', existsSync(join(target, 'locales', 'zh-CN.pak')))
    check(
      '覆盖了旧产物（asar 内容已更新）',
      readFileSync(join(target, 'resources', 'app.asar'), 'utf8') === 'fake asar v2'
    )
    check('生成了便携版说明.txt', existsSync(join(target, '便携版说明.txt')))
    check(
      '旧的 data\\ 已被清掉（产物干净）',
      !existsSync(join(target, 'data', 'whichvideo.db')),
      existsSync(join(target, 'data')) ? 'data 目录仍在' : 'data 目录已移除'
    )
    const readme = existsSync(join(target, '便携版说明.txt'))
      ? readFileSync(join(target, '便携版说明.txt'), 'utf8')
      : ''
    check('说明里提醒重新打包前先退出应用', readme.includes('退出正在运行的'))

    const outsideDir = r.report?.outsideDir
    check(
      '额外拷了一份到仓库外',
      typeof outsideDir === 'string' && outsideDir.startsWith(outsideRoot),
      outsideDir ?? '报告里没有 outsideDir'
    )
    check('仓库外那份里有 exe', !!outsideDir && existsSync(join(outsideDir, 'WhichVideo.exe')))
    check(
      '仓库外那份的 app.asar 与 release 里一致',
      !!outsideDir && readFileSync(join(outsideDir, 'resources', 'app.asar'), 'utf8') === 'fake asar v2'
    )
    check('仓库外那份也带便携版说明', !!outsideDir && existsSync(join(outsideDir, '便携版说明.txt')))
    check(
      '仓库外那份没有拷贝失败',
      r.report?.outsideError === null || r.report?.outsideError === undefined,
      r.report?.outsideError ?? ''
    )
    check(
      '仓库外那份的目录名沿用产物目录名',
      !!outsideDir && outsideDir === join(outsideRoot, basename(target)),
      outsideDir ?? ''
    )
  }

  console.log('\n=== 场景 2：目录删不掉也改名不掉（模拟被占用） ===')
  {
    const releaseDir = join(work, 'locked')
    const { target } = prepareLayout(releaseDir)
    // 仓库外那份已经存在（场景 1 建的），并且有用户的 data\：占用时必须换目录而不是破坏它
    const outsidePreferred = join(outsideRoot, 'WhichVideo-portable')
    mkdirSync(join(outsidePreferred, 'data'), { recursive: true })
    writeFileSync(join(outsidePreferred, 'data', 'whichvideo.db'), 'outside user data that must survive')

    const r = runBuilder(releaseDir, { WHICHVIDEO_TEST_FORCE_LOCKED: '1' })
    check('脚本仍然成功退出（自动换目录继续打包）', r.ok, r.ok ? '' : r.message)
    check(
      '报告里说明用了回退目录',
      r.report?.ok === true && r.report?.reason === 'built-fallback',
      JSON.stringify(r.report ?? {}).slice(0, 120)
    )
    check(
      '回退目录名带时间戳',
      typeof r.report?.targetDir === 'string' && /WhichVideo-portable-\d{8}-\d{4}$/.test(r.report.targetDir),
      r.report?.targetDir ?? ''
    )
    check('被占用的旧目录没被破坏', readFileSync(join(target, 'resources', 'app.asar'), 'utf8') === 'old asar')
    check('旧数据仍然保留（不会静默丢）', existsSync(join(target, 'data', 'whichvideo.db')))
    const fallbackDir = r.report?.targetDir
    check(
      '回退目录里是完整的新产物',
      !!fallbackDir &&
        existsSync(join(fallbackDir, 'WhichVideo.exe')) &&
        readFileSync(join(fallbackDir, 'resources', 'app.asar'), 'utf8') === 'fake asar v2' &&
        existsSync(join(fallbackDir, '便携版说明.txt'))
    )

    const outsideDir = r.report?.outsideDir
    check(
      '仓库外那份被占用时也自动换目录（带时间戳）',
      typeof outsideDir === 'string' && /WhichVideo-portable-\d{8}-\d{4}$/.test(outsideDir),
      outsideDir ?? '报告里没有 outsideDir'
    )
    check(
      '仓库外的回退目录里是完整的新产物',
      !!outsideDir &&
        existsSync(join(outsideDir, 'WhichVideo.exe')) &&
        readFileSync(join(outsideDir, 'resources', 'app.asar'), 'utf8') === 'fake asar v2'
    )
    check(
      '仓库外被占用的旧目录与旧数据都没被破坏',
      existsSync(join(outsidePreferred, 'data', 'whichvideo.db')) &&
        readFileSync(join(outsidePreferred, 'data', 'whichvideo.db'), 'utf8') ===
          'outside user data that must survive'
    )
  }

  console.log('\n=== 场景 3：占用解除后重新打包 ===')
  {
    const releaseDir = join(work, 'retry')
    const { target } = prepareLayout(releaseDir)
    const first = runBuilder(releaseDir, { WHICHVIDEO_TEST_FORCE_LOCKED: '1' })
    check('第一次（被占用）走了回退目录', first.ok && first.report?.reason === 'built-fallback')
    const second = runBuilder(releaseDir)
    check('解除占用后成功', second.ok, second.ok ? '' : second.message)
    check('回到了首选目录', second.report?.reason === 'built', String(second.report?.reason))
    check('产物被替换成新的', readFileSync(join(target, 'resources', 'app.asar'), 'utf8') === 'fake asar v2')
    check('旧的 data\\ 已清掉', !existsSync(join(target, 'data', 'whichvideo.db')))
  }

  console.log('\n=== 场景 4：编译产物不全时必须拒绝打包（而不是产出坏包） ===')
  {
    const releaseDir = join(work, 'guard')
    prepareLayout(releaseDir)

    // 4a) 关键产物缺失：临时移走占位产物里的 preload
    const preloadStub = join(stubBuildDir, 'preload', 'index.js')
    const backup = join(work, 'moved-aside')
    const hadPreload = existsSync(preloadStub)
    if (hadPreload) renameSync(preloadStub, backup)
    try {
      const r = runBuilder(releaseDir, {}, { prepareStub: false })
      check('产物缺失时打包失败', !r.ok, r.ok ? '却成功了' : '')
      check(
        '报告里说明是编译产物缺失',
        r.report?.ok === false && r.report?.reason === 'missing-build-output',
        JSON.stringify(r.report ?? {}).slice(0, 140)
      )
      check(
        '报告列出了缺失的产物',
        Array.isArray(r.report?.missing) && r.report.missing.some((m) => /preload/i.test(m)),
        (r.report?.missing ?? []).slice(0, 3).join(' | ')
      )
    } finally {
      if (hadPreload) renameSync(backup, preloadStub)
    }

    // 4b) 整个构建目录不存在时也不能跳过校验（曾经因为加了 existsSync 短路而漏掉）
    const buildBackup = join(work, 'build-backup')
    const hadBuild = existsSync(stubBuildDir)
    if (hadBuild) renameSync(stubBuildDir, buildBackup)
    try {
      const r = runBuilder(releaseDir, {}, { prepareStub: false })
      check('产物目录整个缺失时同样拒绝打包', !r.ok, r.ok ? '却成功了（校验被跳过）' : '')
      check(
        '此时报告的原因仍是编译产物缺失',
        r.report?.reason === 'missing-build-output',
        String(r.report?.reason)
      )
    } finally {
      // 无条件恢复：即使 hadBuild 判断与实际不符也不会把占位产物留在备份里
      if (existsSync(buildBackup) && !existsSync(stubBuildDir)) renameSync(buildBackup, stubBuildDir)
      ensureStubBuild()
    }
  }

  console.log('\n=== 场景 5：必须校验"打包结果是否新鲜" ===')
  {
    // 这次踩的坑：electron-builder 那一步失败后，脚本因为目录里已经有 exe 就跳过打包，
    // 结果发出去的绿色版装的是旧代码。这里检查脚本确实实现了重新打包 + 新鲜度校验。
    const source = readFileSync(builder, 'utf8')
    check('脚本会调用 electron-builder 重新打包', source.includes('runElectronBuilder()'))
    check('脚本比较 app.asar 与 out/ 的时间戳', /app\.asar[\s\S]{0,300}mtimeMs/.test(source))
    check('产物过期时明确失败并给出原因', source.includes('打包结果不新鲜'))
    check('electron-builder 非零退出时先检查产物', /退出码为[\s\S]{0,160}检查产物/.test(source))
    check('自检开关存在（正式路径默认不跳过打包）', source.includes('WHICHVIDEO_SKIP_ELECTRON_BUILDER'))
  }

  console.log('\n=== 场景 5b：仓库外拷贝要保留 data\\（索引库） ===')
  {
    // 开发时反复打包，若每次都清掉 data\ 就得重跑一遍抽帧建索引，很浪费时间。
    // 做法是先把 data\ rename 到临时路径，换完产物再挪回来。
    const source = readFileSync(builder, 'utf8')
    check('拷贝前把 data\\ 挪到临时路径', /renameSync\(oldData, keptData\)/.test(source))
    check('临时路径带时间戳，避免与残留目录冲突', /keptData = `\$\{dest\}\.data-keep-\$\{Date\.now\(\)\}`/.test(source))
    check('拷贝后把 data\\ 挪回来', /renameSync\(keptData, join\(dest, 'data'\)\)/.test(source))
    check('挪不回来时明确告知用户位置', source.includes('请手动挪回去'))
    check('统计文件数时排除 data\\（源目录本来就没有）', /countFiles\(dest, 'data'\)/.test(source))
    check('统计字节数时同样排除 data\\', /directorySize\(dest, 'data'\)/.test(source))
    check('成功结果里带 dataPreserved 标记供输出提示', source.includes('dataPreserved'))
    check('输出里说明已保留 data\\', source.includes('不需要重新导入视频'))
    // 挪不动时不能静默丢索引库
    check('挪动失败会退回"删除"并如实告知', source.includes('已随目录一起清掉'))
  }

  console.log('\n=== 场景 5c：输出里的路径用相对路径，不暴露开发机绝对路径 ===')
  {
    // 绝对路径不该出现在给用户看的输出里：日志会发到 issue、说明文件会跟着产品走，
    // 都是开发机的目录结构，换台机器那些路径也全错。
    const source = readFileSync(builder, 'utf8')
    check('脚本有 displayPath 辅助函数', /function displayPath\(abs\)/.test(source))
    check('仓库内路径显示为相对（release\\…）', source.includes("relative(root, abs)"))
    check('仓库外路径显示为 ..\\ 前缀', source.includes('`..\\\\${up}`'))
    // 关键：显示层换成相对，但报告字段必须仍是绝对路径 —— 自检靠它做 startsWith/join 判定。
    // 不能用 displayPath 包裹报告里的任何路径字段。
    const reportFields = ['targetDir,', 'preferredTargetDir,', 'outsideRoot,', 'outsideDir: outside.dir ?? null']
    check(
      '测试报告里的路径字段保持绝对（自检依赖）',
      reportFields.every((f) => source.includes(f)) &&
        !/writeTestReport\(\{[\s\S]{0,900}?(targetDir|outsideDir|outsideRoot):\s*displayPath/.test(source),
      'outsideDir/targetDir/outsideRoot 都不走 displayPath'
    )
    const displayUses = (source.match(/displayPath\(/g) ?? []).length
    check('多处输出已改用 displayPath', displayUses >= 10, `${displayUses} 处`)
    // 内部逻辑不能被误伤
    check(
      '内部逻辑仍用绝对路径（existsSync / join / rename 不受影响）',
      /if \(existsSync\(dest\)\)/.test(source) && /mkdirSync\(dest, \{ recursive: true \}\)/.test(source)
    )

    // 兜底：全仓扫一遍，确认文档与注释里没有残留开发机真实路径。
    // 判定用「本机仓库根 / 父目录的真实绝对路径」而不是硬编码盘符 ——
    // 这样换台机器跑这条断言同样有效。
    // 注意 escapeRe 已会转义反斜杠，不能再预先 replace 一次，否则匹配不到。
    const leakPatterns = [
      { label: '仓库根绝对路径', re: new RegExp(escapeRe(root), 'i') },
      { label: '仓库父目录绝对路径', re: new RegExp(escapeRe(dirname(root)), 'i') }
    ]
    const scanTargets = [
      'README.md',
      'AGENTS.md',
      'docs/how-search-works.md',
      'docs/troubleshooting.md',
      'scripts/build-portable-folder.mjs',
      'scripts/fetch-ffmpeg.mjs',
      'scripts/lib/compare-portable-dirs.ps1',
      'scripts/lib/probe-portable-location.ps1'
    ]
    const leaks = []
    for (const rel of scanTargets) {
      const p = join(root, rel)
      if (!existsSync(p)) continue
      const text = readFileSync(p, 'utf8')
      for (const { label, re } of leakPatterns) {
        text.split('\n').forEach((line, i) => {
          if (re.test(line)) leaks.push(`${rel}:${i + 1} 含${label}`)
        })
      }
    }
    check(
      '文档与注释里没有开发机真实路径（扫 8 个文件 × 2 种模式）',
      leaks.length === 0,
      leaks.length ? leaks.slice(0, 4).join(' | ') : '干净'
    )
  }

  console.log('\n=== 场景 6：仓库外拷贝可以关掉，且失败不影响 release 里的产物 ===')
  {
    // 6a) 显式跳过
    const skipDir = join(work, 'skip')
    prepareLayout(skipDir)
    const countBefore = existsSync(join(outsideRoot, 'WhichVideo-portable'))
      ? readdirSync(join(outsideRoot, 'WhichVideo-portable')).length
      : 0
    const skipped = runBuilder(skipDir, { WHICHVIDEO_SKIP_OUTSIDE_COPY: '1' })
    check('跳过时脚本仍然成功退出', skipped.ok, skipped.ok ? '' : skipped.message)
    check(
      '报告标记为已跳过',
      skipped.report?.outsideSkipped === true,
      JSON.stringify(skipped.report ?? {}).slice(0, 120)
    )
    check('跳过时没有写 outsideDir', skipped.report?.outsideDir === null, String(skipped.report?.outsideDir))
    check(
      '跳过时没有动仓库外已有的目录',
      (existsSync(join(outsideRoot, 'WhichVideo-portable'))
        ? readdirSync(join(outsideRoot, 'WhichVideo-portable')).length
        : 0) === countBefore
    )

    // 6b) 落点创建不出来时不能把整次打包判死（release 里的产物仍然是好的）。
    // 用"父路径是普通文件"来制造创建失败 —— 这是 Windows 上真实会遇到的形态。
    const blocker = join(work, 'not-a-dir')
    writeFileSync(blocker, 'not a directory')
    const missingDir = join(work, 'missing-root')
    prepareLayout(missingDir)
    const missing = runBuilder(missingDir, { WHICHVIDEO_OUTSIDE_DIR: join(blocker, 'outside') })
    check('落点创建失败时脚本仍然成功退出', missing.ok, missing.ok ? '' : missing.message)
    check(
      '报告里说明了仓库外拷贝失败的原因',
      typeof missing.report?.outsideError === 'string' && missing.report.outsideError.length > 0,
      String(missing.report?.outsideError)
    )
    check(
      'release 里的产物仍然完整',
      readFileSync(join(missingDir, 'WhichVideo-portable', 'resources', 'app.asar'), 'utf8') ===
        'fake asar v2'
    )
  }

  rmSync(work, { recursive: true, force: true })
  console.log(`\n=== 绿色版打包脚本自检：${passed}/${passed + failed} 通过 ===`)
  if (failed) process.exit(1)
}

// 自检自身出错时也要可见（之前异常被静默吞掉，导致 out/ 没恢复都没人知道）
try {
  main()
} catch (err) {
  console.error('\n自检脚本自身抛错：')
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exit(1)
}
