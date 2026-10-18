import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const run = spawnSync(
  'cargo',
  ['test', '--offline', '--manifest-path', 'src-tauri/Cargo.toml'],
  {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, CARGO_PROFILE_DEV_DEBUG: '0' }
  }
)
process.exit(run.status ?? 1)
