/** 发布元数据门禁：标签、三个版本号、Windows 打包目标与版本说明必须一致。 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tauri = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))
const cargo = readFileSync(join(root, 'src-tauri', 'Cargo.toml'), 'utf8')
const cargoVersion = cargo.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1]
const expectedTag = `v${pkg.version}`
const tag = process.argv[2] ?? process.env.RELEASE_TAG ?? expectedTag

if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`无效发布标签：${tag}`)
if (tag !== expectedTag || tauri.version !== pkg.version || cargoVersion !== pkg.version) {
  throw new Error(`版本不一致：tag=${tag}, package=${pkg.version}, tauri=${tauri.version}, cargo=${cargoVersion}`)
}
if (tauri.bundle?.targets !== 'nsis') throw new Error('当前仅发布 Windows NSIS 安装包')

const notesPath = join(root, 'docs', 'releases', `${tag}.md`)
if (!existsSync(notesPath)) throw new Error(`缺少版本说明：${notesPath}`)
const notes = readFileSync(notesPath, 'utf8')
if (!notes.includes(`# WhichVideo ${tag}`) || notes.trim().length < 100) {
  throw new Error(`版本说明不完整：${notesPath}`)
}
console.log(`发布元数据自检通过：${tag}（Windows x64，NSIS + 便携版）`)
