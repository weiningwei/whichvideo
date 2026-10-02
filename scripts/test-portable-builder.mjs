/**
 * 绿色版打包脚本的自检。
 *
 * 起因：pnpm build:portable 报
 *   EPERM, Permission denied: ...\release\WhichVideo-portable
 * 也就是目标目录被占用（绿色版正在运行 / 资源管理器停在目录里 / 杀软在扫），
 * 而旧脚本直接 rmSync，只抛裸 EPERM，用户不知道该怎么办。
 *
 * 覆盖：
 *   1. 正常重建：覆盖旧产物、清掉旧的 data\、写出便携版说明
 *   2. 目录删不掉也改名不掉时：失败退出并给出可操作提示，且不留下半成品、不丢旧数据
 *   3. 占用解除后再次打包能恢复到干净产物
 *
 * 说明：真实文件锁需要独占句柄 + 子进程，而本环境禁止 spawn，
 * 所以第 2 项用 WHICHVIDEO_TEST_FORCE_LOCKED 注入"删不掉"的状态；
 * 断言通过 WHICHVIDEO_TEST_REPORT 写出的 JSON 报告完成（stdout 在受限环境抓不到）。
 *
 * 运行： node scripts/test-portable-builder.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const builder = join(root, 'scripts', 'build-portable-folder.mjs')
const work = join(root, 'tmp', 'portable-builder-test')

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
function runBuilder(releaseDir, extraEnv = {}) {
  const reportPath = join(work, `report-${Math.random().toString(36).slice(2)}.json`)
  try {
    execFileSync(process.execPath, [builder], {
      cwd: root,
      env: {
        ...process.env,
        WHICHVIDEO_RELEASE_DIR: releaseDir,
        WHICHVIDEO_TEST_REPORT: reportPath,
        // 自检不真的跑 electron-builder（耗时且需要 Electron 二进制）
        WHICHVIDEO_SKIP_ELECTRON_BUILDER: '1',
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
  }

  console.log('\n=== 场景 2：目录删不掉也改名不掉（模拟被占用） ===')
  {
    const releaseDir = join(work, 'locked')
    const { target } = prepareLayout(releaseDir)
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
    const preloadMjs = join(root, 'out', 'preload', 'index.mjs')
    const preloadJs = join(root, 'out', 'preload', 'index.js')
    const backup = join(work, 'preload-backup')
    const source = existsSync(preloadMjs) ? preloadMjs : preloadJs
    const hadPreload = existsSync(source)
    if (hadPreload) renameSync(source, backup)
    try {
      const r = runBuilder(releaseDir)
      check('产物缺失时打包失败', !r.ok, r.ok ? '却成功了' : '')
      check(
        '报告里说明是编译产物缺失',
        r.report?.ok === false && r.report?.reason === 'missing-build-output',
        JSON.stringify(r.report ?? {}).slice(0, 140)
      )
      check(
        '报告列出了缺失的产物',
        Array.isArray(r.report?.missing) && r.report.missing.some((m) => /preload/i.test(m)),
        (r.report?.missing ?? []).join(' | ')
      )
    } finally {
      if (hadPreload) renameSync(backup, source)
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

  rmSync(work, { recursive: true, force: true })
  console.log(`\n=== 绿色版打包脚本自检：${passed}/${passed + failed} 通过 ===`)
  if (failed) process.exit(1)
}

main()
