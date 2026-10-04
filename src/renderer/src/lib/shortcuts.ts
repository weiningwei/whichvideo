/**
 * 快捷键的单一事实来源。
 *
 * 键位声明集中在这里，行为实现在各组件的 keydown 处理里，帮助面板也从这张表
 * 生成 —— 三者不会漂移。原先键位散落在 App.tsx 与 LibraryView.tsx 的 switch
 * 里，想知道"有哪些快捷键"只能通读代码。
 *
 * 选键参考同类工具的习惯：
 *   · 列表导航（↑↓ / Enter / Esc）—— Everything、VLC、邮件客户端
 *   · 危险操作不占主键（删除用 Delete 而不是 Backspace，避免误触）
 *   · / 聚焦搜索框 —— GitHub、Notion、Slack
 *   · ? 帮助面板 —— GitHub、Figma、Linear
 *   · 1/2 切页签 —— 浏览器、VS Code
 */

/** 单个快捷键的展示信息（帮助面板用） */
export interface ShortcutDoc {
  /** 按键名，如 'Enter'、'Delete'、'Ctrl' */
  keys: string
  /** 做什么 */
  label: string
  /** 分组标题 */
  group: string
  /** 是否只在分组视图下生效 */
  onlyGrouped?: boolean
}

/** 平台判断：Mac 上 Ctrl 类按键显示为 ⌘，且 primary 键是 Meta */
export const isMac =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent)

/** 把逻辑键名转成该平台该显示的样子 */
export function renderKeys(keys: string): string {
  return keys
    .split('+')
    .map((k) => {
      if (k === 'Ctrl') return isMac ? '⌘' : 'Ctrl'
      if (k === 'Shift') return isMac ? '⇧' : 'Shift'
      if (k === 'Alt') return isMac ? '⌥' : 'Alt'
      return k
    })
    .join(isMac ? '' : '+')
}

/** 帮助面板用的完整列表。顺序即面板里的排列顺序 */
export const SHORTCUTS: ShortcutDoc[] = [
  // ---- 通用 ----
  { group: '通用', keys: '?', label: '显示 / 隐藏本帮助' },
  { group: '通用', keys: '1', label: '切到图片搜索' },
  { group: '通用', keys: '2', label: '切到视频库与监听' },
  { group: '通用', keys: '/', label: '聚焦视频库的筛选框' },
  { group: '通用', keys: 'Ctrl+K', label: '聚焦链接输入框（在搜索页）' },
  { group: '通用', keys: 'F5', label: '刷新当前页' },

  // ---- 列表导航 ----
  { group: '列表导航', keys: '↑', label: '焦点上移一行' },
  { group: '列表导航', keys: '↓', label: '焦点下移一行' },
  { group: '列表导航', keys: 'Home', label: '跳到第一行' },
  { group: '列表导航', keys: 'End', label: '跳到最后一行' },
  { group: '列表导航', keys: 'PageUp', label: '上翻一页' },
  { group: '列表导航', keys: 'PageDown', label: '下翻一页' },
  { group: '列表导航', keys: '→', label: '展开分组', onlyGrouped: true },
  { group: '列表导航', keys: '←', label: '收起分组', onlyGrouped: true },

  // ---- 选择 ----
  { group: '选择', keys: 'Space', label: '切换选中（Shift 连选 / Ctrl 点选）' },
  { group: '选择', keys: 'Ctrl+A', label: '全选当前页' },
  { group: '选择', keys: 'Escape', label: '取消选择 / 关闭弹层' },

  // ---- 已选视频的操作 ----
  { group: '操作', keys: 'Enter', label: '播放（优先播放第一个选中的，否则焦点处）' },
  { group: '操作', keys: 'Delete', label: '从索引库移除（不删磁盘文件）' },
  { group: '操作', keys: 'Ctrl+L', label: '在资源管理器中定位' },
  { group: '操作', keys: 'Ctrl+R', label: '重建焦点视频的索引' },

  // ---- 视频库 ----
  { group: '视频库', keys: 'G', label: '分组 / 平铺切换' },
  { group: '视频库', keys: 'I', label: '导入视频文件' },
  { group: '视频库', keys: 'Ctrl+Shift+I', label: '导入文件夹' },
  { group: '视频库', keys: 'S', label: '重新扫描监听目录' },
  { group: '视频库', keys: 'B', label: '重建全部索引' }
]

/** 按 group 聚合成有序数组，供面板渲染 */
export function groupShortcuts(): { group: string; items: ShortcutDoc[] }[] {
  const out: { group: string; items: ShortcutDoc[] }[] = []
  for (const s of SHORTCUTS) {
    const last = out[out.length - 1]
    if (last && last.group === s.group) last.items.push(s)
    else out.push({ group: s.group, items: [s] })
  }
  return out
}
