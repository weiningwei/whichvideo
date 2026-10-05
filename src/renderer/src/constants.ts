/**
 * 渲染端常量。
 *
 * 只收跨组件共享的数值；快捷键表归 `lib/shortcuts.ts`（帮助面板的单一事实来源），
 * 表格列宽/行高留在 JSX 里——Tailwind 的任意值类名（`w-[180px]`）必须是完整字面量，
 * 抽成模板字符串会被 JIT 扫描漏掉导致样式丢失。
 */

/** PageUp / PageDown 一次跳多少行（按"一屏约 15 行"取整） */
export const PAGE_JUMP = 15
