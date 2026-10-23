import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const compile = (path) => ts.transpileModule(readFileSync(path, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText
const errorsUrl = moduleUrl(compile('src/renderer/src/lib/errors.ts'))
const { AppError, normalizeError, errorMessage } = await import(errorsUrl)
const original = new Error('数据库暂时不可用')
assert.equal(errorMessage(original), original.message)
assert.equal(errorMessage('读取失败'), '读取失败')
for (const input of [null, undefined, {}, 42, '', '   ', { message: 17 }]) {
  assert.equal(errorMessage(input), '操作失败，请重试')
}
const structured = normalizeError({ code: 'timeout', message: '请求超时', operation: 'search_url' })
assert.equal(structured.code, 'timeout')
assert.equal(structured.operation, 'search_url')
assert.equal(normalizeError(structured), structured)
assert.equal(normalizeError({ code: 'unknown', message: '失败' }).code, 'internal')
assert.equal(normalizeError(original).cause, original)

const mockUrl = moduleUrl(`
export let invokeImpl = async () => null;
export let listenImpl = async () => () => {};
export const setInvoke = (fn) => { invokeImpl = fn };
export const setListen = (fn) => { listenImpl = fn };
export const invoke = (...args) => invokeImpl(...args);
export const listen = (...args) => listenImpl(...args);
`)
const mock = await import(mockUrl)
const sharedUrl = moduleUrl(compile('src/shared/types.ts'))
const contractUrl = moduleUrl(compile('src/renderer/src/lib/ipc-contract.ts'))
const bridgeUrl = moduleUrl(compile('src/renderer/src/lib/tauri-api.ts')
  .replaceAll("'@tauri-apps/api/core'", JSON.stringify(mockUrl))
  .replaceAll("'@tauri-apps/api/event'", JSON.stringify(mockUrl))
  .replaceAll("'@shared/types'", JSON.stringify(sharedUrl))
  .replaceAll("'./ipc-contract'", JSON.stringify(contractUrl))
  .replaceAll("'./errors'", JSON.stringify(errorsUrl)))
const { tauriApi } = await import(bridgeUrl)
const failure = { code: 'internal', message: '读取失败', operation: 'library_stats' }
mock.setInvoke(async () => { throw failure })
await assert.rejects(tauriApi.library.stats(), error =>
  error instanceof AppError && error.message === '读取失败' && error.operation === 'library_stats' && error.cause === failure)
mock.setInvoke(async () => { throw '旧版字符串错误' })
await assert.rejects(tauriApi.library.stats(), { message: '旧版字符串错误', code: 'internal' })

const logged = []
const previousConsoleError = console.error
console.error = (...args) => logged.push(args)
try {
  mock.setInvoke(async () => ({ videos: 2 }))
  await assert.rejects(tauriApi.library.stats(), { code: 'invalid-response', operation: 'library_stats' })
  assert.equal(logged.length, 1)
  mock.setInvoke(async () => null)
  assert.equal(await tauriApi.videos.get(42), null)

  const notices = []
  mock.setListen(async () => { throw failure })
  tauriApi.events.subscribe(event => notices.push(event))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(notices.length, 1)
  assert.match(notices[0].message, /读取失败/)

  let rejectListen
  mock.setListen(() => new Promise((_, reject) => { rejectListen = reject }))
  const close = tauriApi.events.subscribe(event => notices.push(event))
  close()
  rejectListen(failure)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(notices.length, 1, '关闭后的订阅失败不能再提示')
} finally {
  console.error = previousConsoleError
}
console.log('✓ 错误规范化、IPC 拒绝、契约校验、成功值及订阅生命周期通过')
