import type { ErrorCode } from '@shared/result'

const codes: readonly string[] = [
  'invalid-input', 'unsupported-protocol', 'http-error', 'timeout', 'too-large',
  'too-many-redirects', 'network', 'no-image', 'decode-failed', 'internal',
  'invalid-response'
]

/** One in-process representation for IPC rejections and local failures. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode | 'invalid-response' = 'internal',
    readonly operation?: string,
    cause?: unknown
  ) {
    super(message, { cause })
    this.name = 'AppError'
  }
}

export function normalizeError(error: unknown, operation?: string): AppError {
  if (error instanceof AppError) return error
  let message = '操作失败，请重试'
  let code: AppError['code'] = 'internal'
  if (typeof error === 'string' && error.trim()) message = error
  if (error !== null && typeof error === 'object') {
    const value = error as Record<string, unknown>
    if (typeof value.message === 'string' && value.message.trim()) message = value.message
    if (typeof value.code === 'string' && codes.includes(value.code)) code = value.code as AppError['code']
    if (typeof value.operation === 'string' && !operation) operation = value.operation
  }
  return new AppError(message, code, operation, error)
}

export function errorMessage(error: unknown): string {
  return normalizeError(error).message
}
