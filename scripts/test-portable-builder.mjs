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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    check('脚本以失败退出', !r.ok, r.ok ? '却成功了' : '')
    check(
      '报告里说明了失败原因是目录被占用',
      r.report?.ok === false && r.report?.reason === 'target-locked',
      JSON.stringify(r.report ?? {}).slice(0, 100)
    )
    check(
      '给出了可操作的排查方向',
      Array.isArray(r.report?.hints) && r.report.hints.some((h) => /资源管理器|杀毒软件|WhichVideo\.exe/.test(h)),
      (r.report?.hints ?? []).join(' | ').slice(0, 120)
    )
    check('没有写入半成品（仍是旧 asar）', readFileSync(join(target, 'resources', 'app.asar'), 'utf8') === 'old asar')
    check('旧数据仍然保留（不会静默丢）', existsSync(join(target, 'data', 'whichvideo.db')))
  }

  console.log('\n=== 场景 3：占用解除后重新打包 ===')
  {
    const releaseDir = join(work, 'retry')
    const { target } = prepareLayout(releaseDir)
    const first = runBuilder(releaseDir, { WHICHVIDEO_TEST_FORCE_LOCKED: '1' })
    check('第一次（被占用）失败', !first.ok)
    const second = runBuilder(releaseDir)
    check('解除占用后成功', second.ok, second.ok ? '' : second.message)
    check('产物被替换成新的', readFileSync(join(target, 'resources', 'app.asar'), 'utf8') === 'fake asar v2')
    check('旧的 data\\ 已清掉', !existsSync(join(target, 'data', 'whichvideo.db')))
  }

  rmSync(work, { recursive: true, force: true })
  console.log(`\n=== 绿色版打包脚本自检：${passed}/${passed + failed} 通过 ===`)
  if (failed) process.exit(1)
}

main()
