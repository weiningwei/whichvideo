/**
 * Electron 桩：让主进程能在纯 Node 环境下跑起来做启动自检。
 * 只实现主进程实际用到的 API，足够验证"启动链路 + 失败可见性"。
 */
import { EventEmitter } from 'node:events'
import { join } from 'node:path'

export const state = {
  windows: [],
  shown: 0,
  paths: new Map(),
  switches: [],
  loadedUrls: [],
  quitCalls: 0,
  singleInstanceLock: true,
  secondInstanceHandlers: [],
  appListeners: new Map(),
  menuSet: 0
}

export function resetState() {
  state.windows.length = 0
  state.shown = 0
  state.paths.clear()
  state.switches.length = 0
  state.loadedUrls.length = 0
  state.quitCalls = 0
  state.singleInstanceLock = true
  state.secondInstanceHandlers.length = 0
  state.appListeners.clear()
  state.menuSet = 0
}

class FakeWebContents extends EventEmitter {
  constructor(win) {
    super()
    this.win = win
    this.sent = []
  }
  send(channel, payload) {
    this.sent.push({ channel, payload })
  }
  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler
  }
  async executeJavaScript() {
    return undefined
  }
}

export class FakeBrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super()
    this.options = options
    this.visible = false
    this.destroyed = false
    this.webContents = new FakeWebContents(this)
    state.windows.push(this)
  }
  show() {
    this.visible = true
    state.shown++
    this.emit('show')
  }
  hide() {
    this.visible = false
  }
  focus() {}
  isVisible() {
    return this.visible
  }
  isMinimized() {
    return false
  }
  restore() {}
  isDestroyed() {
    return this.destroyed
  }
  close() {
    this.destroyed = true
    this.emit('closed')
  }
  async loadURL(url) {
    state.loadedUrls.push(url)
    // 模拟异步加载完成
    setImmediate(() => {
      this.webContents.emit('did-finish-load')
      this.emit('ready-to-show')
    })
  }
  async loadFile(file) {
    state.loadedUrls.push(`file://${file}`)
    setImmediate(() => {
      this.webContents.emit('did-finish-load')
      this.emit('ready-to-show')
    })
  }
  static getAllWindows() {
    return state.windows.filter((w) => !w.destroyed)
  }
}

export const app = {
  // 默认当作"打包后的应用"；自检可临时关掉来模拟开发模式（不触发 exe 同级 data 回退）
  get isPackaged() {
    return process.env.__TEST_IS_PACKAGED__ !== 'false'
  },
  requestSingleInstanceLock() {
    return state.singleInstanceLock
  },
  getPath(name) {
    if (state.paths.has(name)) return state.paths.get(name)
    if (name === 'exe') return process.env.__TEST_EXE__ ?? join(process.cwd(), 'WhichVideo.exe')
    // 默认：userData 指向自检的临时目录，exe 也在临时目录里
    return process.env.__TEST_TMP__ ?? process.cwd()
  },
  setPath(name, value) {
    state.paths.set(name, value)
  },
  getAppPath() {
    return process.env.__TEST_APP_PATH__ ?? process.cwd()
  },
  commandLine: {
    appendSwitch(name) {
      state.switches.push(name)
    }
  },
  whenReady() {
    return Promise.resolve()
  },
  on(event, handler) {
    const list = state.appListeners.get(event) ?? []
    list.push(handler)
    state.appListeners.set(event, list)
  },
  quit() {
    state.quitCalls++
  },
  setAppUserModelId() {},
  setLoginItemSettings() {},
  async getFileIcon() {
    return emptyNativeImage()
  },
  async setAsDefaultProtocolClient() {},
  getVersion() {
    return '0.1.0'
  },
  getName() {
    return 'WhichVideo'
  }
}

function emptyNativeImage() {
  return {
    isEmpty: () => true,
    getSize: () => ({ width: 0, height: 0 }),
    toBitmap: () => Buffer.alloc(0),
    toPNG: () => Buffer.alloc(0),
    resize: () => emptyNativeImage()
  }
}

export const nativeImage = {
  createFromPath() {
    return emptyNativeImage()
  },
  createFromDataURL() {
    return emptyNativeImage()
  },
  createFromBuffer() {
    return emptyNativeImage()
  }
}

export const ipcMain = {
  handlers: new Map(),
  handle(channel, handler) {
    this.handlers.set(channel, handler)
  },
  removeHandler(channel) {
    this.handlers.delete(channel)
  }
}

export const shell = {
  openPath: async () => '',
  openExternal: async () => {},
  showItemInFolder: () => {}
}

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showMessageBox: async () => ({ response: 0 }),
  showErrorBox: () => {}
}

export const clipboard = {
  has: async () => false,
  read: async () => [],
  readText: async () => '',
  write: async () => {},
  writeText: async () => {}
}

export const Menu = {
  setApplicationMenu() {
    state.menuSet++
  },
  buildFromTemplate: () => ({})
}

export const screen = {
  getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } })
}

export default {
  app,
  BrowserWindow: FakeBrowserWindow,
  nativeImage,
  ipcMain,
  shell,
  dialog,
  clipboard,
  Menu,
  screen
}
