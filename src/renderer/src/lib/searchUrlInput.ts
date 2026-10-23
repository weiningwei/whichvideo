import type { SearchOutcome } from '../hooks/useSearch'

/** 成功后仅清除本次提交的链接；失败或用户随后输入了新链接时保留文本。 */
export function urlInputAfterSearch(current: string, submitted: string, outcome: SearchOutcome): string {
  return outcome.ok && current.trim() === submitted ? '' : current
}
