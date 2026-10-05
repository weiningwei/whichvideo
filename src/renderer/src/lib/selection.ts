import type { MouseEvent } from 'react'

/**
 * 拦掉「带修饰键的按下」顺带启动的浏览器原生文本选中。
 *
 * 行多选走 Shift/Ctrl 点击，而 Shift+按下会把标题与按钮用 ::selection 蓝底盖住；
 * Ctrl 点击不启动文本选中，于是看着像「只有 Shift 有 bug」。只拦带修饰键的按下
 * 并清掉残留选区：普通点击/拖选不受影响，文件名仍能选中复制。
 * 整行 select-none 也能关掉蓝底，但会连文件名的双击/拖选一起干掉 —— 别走回头路。
 */
export const blockModifierTextSelection = (e: MouseEvent) => {
  if (e.shiftKey || e.ctrlKey || e.metaKey) {
    e.preventDefault()
    window.getSelection()?.removeAllRanges()
  }
}
