/**
 * 从系统剪贴板挑出图片（Electron 44 的 clipboard 是 W3C 风格异步 API：read() → ClipboardItem[]）。
 *
 * 为什么单独成一个模块：Electron 的 clipboard / nativeImage 在纯 Node 下不存在，
 * 把「按什么顺序挑哪张图」这段抽出来并注入最小接口，就能在
 * scripts/test-clipboard.mjs 里直接覆盖，不必启动 Electron。
 *
 * 踩过的坑 —— 不能先 `clipboard.has('image/png')` 卡一道白名单：
 * Windows 上很多来源（画图、部分浏览器右键复制、Office、聊天软件）只放
 * image/bmp(DIB) 或 image/jpeg，一道 PNG 门槛会把它们全挡在外面，界面上只剩
 * 一句"剪贴板里没有图片"，用户看不出到底发生了什么。这里一律扫全部 image/*。
 */

export interface ClipboardItemLike {
  readonly types?: readonly string[]
  getType(type: string): Promise<unknown>
}

export interface ClipboardLike {
  read(): Promise<ClipboardItemLike[]>
}

export interface ClipboardImageBytes {
  /** 图片原始字节，交给 nativeImage.createFromBuffer 解析 */
  buffer: Buffer
  /** 选中的 MIME 类型，例如 image/png */
  type: string
}

export interface ClipboardLogger {
  log?: (message: string) => void
  logError?: (scope: string, err: unknown) => void
}

/**
 * 读出剪贴板里第一张可用的图片。
 *
 * 契约：**不抛异常**，`null` 一律表示"这次没有拿到可用图片"，
 * 具体原因（剪贴板有哪些格式、解析哪里出错）写进日志。
 */
export async function readClipboardImageBytes(
  clipboard: ClipboardLike,
  logger: ClipboardLogger = {}
): Promise<ClipboardImageBytes | null> {
  const { log = () => {}, logError = () => {} } = logger

  let items: ClipboardItemLike[]
  try {
    items = await clipboard.read()
  } catch (err) {
    logError('读取剪贴板失败', err)
    return null
  }

  const imageTypes: string[] = []
  const allTypes: string[] = []

  for (const item of items ?? []) {
    for (const type of item.types ?? []) {
      allTypes.push(type)
      if (!type.startsWith('image/')) continue
      if (imageTypes.includes(type)) continue
      imageTypes.push(type)

      let buffer: Buffer
      try {
        const blob = (await item.getType(type)) as Blob
        if (typeof blob === 'string' || typeof blob?.arrayBuffer !== 'function') continue
        const bytes = Buffer.from(await blob.arrayBuffer())
        if (bytes.length === 0) continue
        buffer = bytes
      } catch (err) {
        logError('剪贴板图片解析', err)
        continue
      }
      return { buffer, type }
    }
  }

  const summary = [...new Set(allTypes)].join(', ') || '空'
  log(`剪贴板里没有可用图片（当前格式：${summary}）`)
  return null
}
