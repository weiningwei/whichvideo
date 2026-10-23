export type RequestToken = number

/** 只允许最近一次异步请求更新界面；失效操作也会让所有在途请求过期。 */
export class RequestGate {
  private generation = 0

  begin(): RequestToken {
    return ++this.generation
  }

  invalidate(): void {
    this.generation++
  }

  isCurrent(token: RequestToken): boolean {
    return token === this.generation
  }
}
