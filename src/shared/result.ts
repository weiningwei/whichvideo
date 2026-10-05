/**
 * 统一的失败表达：Result 判别式联合 + 错误码枚举。
 *
 * 约定两层信息各司其职：
 *   · `code`    —— 机器可读，供测试断言与界面分支（超时可以提示"稍后重试"，
 *                 协议不支持则只能改链接，两者不该显示同一句话）
 *   · `message` —— 人可读的中文说明，直接展示给用户
 *
 * 此前失败只带 message（字符串），测试只能靠文案子串匹配判断失败原因，
 * 文案一改测试就断；代码调用方也无法区分"用户输入错"与"网络临时故障"。
 */

/** 失败原因分类。新增分类时同时检查：调用点赋值、test:url 断言 */
export type ErrorCode =
  /** 用户输入不合法：空串、不是 URL */
  | 'invalid-input'
  /** 协议不支持：非 http(s)，或重定向到了 file: 等本地协议 */
  | 'unsupported-protocol'
  /** HTTP 非 2xx / 响应头缺失 / 响应体异常 */
  | 'http-error'
  /** 请求超时（含手动 abort） */
  | 'timeout'
  /** 响应体超过体积上限 */
  | 'too-large'
  /** 重定向次数超限 */
  | 'too-many-redirects'
  /** 连接失败、DNS 解析失败等 fetch 抛错 */
  | 'network'
  /** 网页里没找到图片，或找到的地址不是图片 */
  | 'no-image'
  /** 字节到不了可用图片：解码失败、位图转换失败 */
  | 'decode-failed'
  /** 未分类的内部错误（兜底，尽量别用） */
  | 'internal'

/** 失败分支的统一形状 */
export interface Fail {
  ok: false
  code: ErrorCode
  /** 面向用户的中文说明 */
  message: string
}

/**
 * Result：`ok` 为判别字段。
 * 成功分支把载荷平铺在顶层（`{ ok: true, ...payload }`），访问时不必多一层 value。
 */
export type Result<T> = ({ ok: true } & T) | Fail

export function fail(code: ErrorCode, message: string): Fail {
  return { ok: false, code, message }
}
