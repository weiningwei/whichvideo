import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve('.')
const binary = join(root, 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'whichvideo-tauri.exe' : 'whichvideo-tauri')
const runDir = process.env.WHICHVIDEO_E2E_RUN_DIR
if (!runDir) throw new Error('请通过 pnpm test:e2e 运行，避免使用真实用户数据目录')

export const config = {
  runner: 'local',
  specs: [join(root, 'scripts', 'e2e', 'specs', '*.spec.mjs').replaceAll('\\', '/')],
  maxInstances: 1,
  services: [['tauri', { appBinaryPath: binary, driverProvider: 'embedded' }]],
  capabilities: [{ browserName: 'tauri', 'tauri:options': { application: binary } }],
  framework: 'mocha',
  reporters: ['spec'],
  logLevel: 'warn',
  waitforTimeout: 30000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 1,
  mochaOpts: { ui: 'bdd', timeout: 180000 },
  async afterTest(test, _context, result) {
    if (result.passed) return
    const screenshots = join(runDir, 'screenshots')
    mkdirSync(screenshots, { recursive: true })
    await browser.saveScreenshot(join(screenshots, `${test.title.replace(/[^\w-]+/g, '_')}.png`)).catch(() => {})
  }
}
