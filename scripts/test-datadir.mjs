/**
 * 便携（绿色）模式数据目录判定的单元测试。
 *
 * 直接测 src/main/datadir.ts 的纯函数逻辑（不依赖 Electron），
 * 覆盖：环境变量、便携版启动器、打包后 exe 目录、不可写目录回退、默认位置。
 *
 * 运行： node scripts/test-datadir.mjs   （需先 node scripts/build-core.mjs）
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const out = join(root, 'out-e2e')
const work = join(root, 'tmp', 'datadir-test')

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

async function main() {
  if (!existsSync(join(out, 'main', 'datadir.js'))) {
    console.error('请先运行 node scripts/build-core.mjs')
    process.exit(1)
  }
  const mod = await import(pathToFileURL(join(out, 'main', 'datadir.js')).href)
  const { resolveDataDir, portableMarkerPath, DATABASE_FILES } = mod

  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })

  /** 真实的可写性判断 */
  const isWritable = (dir) => {
    try {
      mkdirSync(dir, { recursive: true })
      const probe = join(dir, '.probe')
      writeFileSync(probe, 'x')
      rmSync(probe, { force: true })
      return true
    } catch {
      return false
    }
  }

  const legacyDir = join(work, 'appdata', 'WhichVideo')
  const portableBase = join(work, 'usb')
  const exeDir = join(work, 'green')
  mkdirSync(portableBase, { recursive: true })
  mkdirSync(exeDir, { recursive: true })

  const base = { legacyDir, exeDir, isPackaged: true, isWritable }

  /* ---------- 1. 默认（安装版装在 Program Files，exe 目录不可写） ---------- */
  {
    const r = resolveDataDir({
      ...base,
      isWritable: (dir) =>
        !resolve(dir).startsWith(resolve(exeDir)) || resolve(dir) === resolve(legacyDir)
    })
    check('安装版使用系统默认目录', r.dir === legacyDir && !r.portable && r.source === 'default', JSON.stringify(r))
  }

  /* ---------- 2. 便携版启动器 ---------- */
  {
    const r = resolveDataDir({ ...base, portableDir: portableBase })
    check(
      '便携版启动器 → exe 同级 data 目录',
      r.dir === join(portableBase, 'data') && r.portable && r.source === 'portable-launcher',
      r.dir
    )
  }

  /* ---------- 3. 环境变量优先 ---------- */
  {
    const custom = join(work, 'custom-data')
    const r = resolveDataDir({ ...base, envDir: custom, portableDir: portableBase })
    check(
      'WHICHVIDEO_DATA_DIR 优先于便携目录',
      r.dir === resolve(custom) && r.portable && r.source === 'env',
      r.dir
    )
  }

  /* ---------- 4. 环境变量不可写时回退 ---------- */
  {
    const bad = join(work, 'locked')
    mkdirSync(bad, { recursive: true })
    const r = resolveDataDir({
      ...base,
      envDir: bad,
      portableDir: portableBase,
      // 只让 locked 目录不可写，其余照常
      isWritable: (dir) => (resolve(dir) === resolve(bad) ? false : true)
    })
    check('环境变量目录不可写时回退到便携目录', r.source === 'portable-launcher', JSON.stringify(r))
  }

  /* ---------- 5. 未打包（开发模式）不误判 ---------- */
  {
    const r = resolveDataDir({ ...base, isPackaged: false, portableDir: undefined })
    check('开发模式不会误判为便携', !r.portable && r.dir === legacyDir, JSON.stringify(r))
  }

  /* ---------- 6. 解压到可写目录直接运行 ---------- */
  {
    const r = resolveDataDir({ ...base, portableDir: undefined })
    check('打包后 exe 所在目录可写 → 便携模式', r.dir === join(exeDir, 'data') && r.source === 'portable-launcher', r.dir)
  }

  /* ---------- 7. exe 目录只读（装到 Program Files） ---------- */
  {
    const r = resolveDataDir({
      ...base,
      portableDir: undefined,
      isWritable: (dir) => resolve(dir) !== resolve(exeDir) && !resolve(dir).startsWith(resolve(exeDir))
    })
    check('exe 目录只读时回到默认目录', r.dir === legacyDir && !r.portable, JSON.stringify(r))
  }

  /* ---------- 8. 标记文件与迁移清单 ---------- */
  {
    check('便携标记文件名固定', portableMarkerPath(join(work, 'x')).endsWith('whichvideo.portable'))
    check(
      '迁移清单包含 WAL / SHM',
      DATABASE_FILES.includes('whichvideo.db') &&
        DATABASE_FILES.includes('whichvideo.db-wal') &&
        DATABASE_FILES.includes('whichvideo.db-shm'),
      DATABASE_FILES.join(', ')
    )
  }

  /* ---------- 9. 主进程确实接上了这套逻辑 ---------- */
  {
    const source = readFileSync(join(root, 'src', 'main', 'index.ts'), 'utf8')
    check('主进程设置了 userData 与 sessionData', source.includes("app.setPath('userData'") && source.includes("app.setPath('sessionData'"))
    check('主进程移植了旧索引库', source.includes('migrateLegacyDatabase'))
    check('便携模式禁用 HTTP 缓存（避免写 temp）', source.includes("disable-http-cache"))
    check('便携目录也参与 ffmpeg 查找', source.includes("join(dataDir.dir, 'bin')"))
  }

  /* ---------- 10. 打包配置走的是"免解压目录版" ---------- */
  {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    check('打包配置包含 dir 目标（免安装目录版）', /-\s*target:\s*dir/.test(yml))
    check('打包配置包含 nsis 目标（安装包）', /-\s*target:\s*nsis/.test(yml))
    check(
      '没有启用单文件自解压 portable 目标',
      !/^\s*portable:/m.test(yml) && !/-\s*target:\s*portable/m.test(yml)
    )
    check('存在绿色版整理脚本', existsSync(join(root, 'scripts', 'build-portable-folder.mjs')))
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    check('提供 build:portable 脚本', typeof pkg.scripts['build:portable'] === 'string', pkg.scripts['build:portable'])
  }

  rmSync(work, { recursive: true, force: true })
  console.log(`\n=== 便携数据目录：${passed}/${passed + failed} 通过 ===`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error('\n测试异常：', err)
  process.exit(1)
})
