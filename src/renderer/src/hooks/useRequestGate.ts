import { useEffect, useRef } from 'react'
import { RequestGate } from '../lib/requestGate'

/** 提供稳定的请求门，并在组件卸载时使所有在途请求失效。 */
export function useRequestGate(): RequestGate {
  const gateRef = useRef<RequestGate | null>(null)
  if (gateRef.current === null) gateRef.current = new RequestGate()
  const gate = gateRef.current

  useEffect(() => () => gate.invalidate(), [gate])
  return gate
}
