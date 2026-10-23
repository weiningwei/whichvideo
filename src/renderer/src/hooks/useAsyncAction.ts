import { useCallback, useRef, useState } from 'react'

/** 单个 UI 动作的运行状态，并阻止按钮连点重复提交。 */
export function useAsyncAction() {
  const [running, setRunning] = useState(false)
  const runningRef = useRef(false)

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    if (runningRef.current) return undefined
    runningRef.current = true
    setRunning(true)
    try {
      return await action()
    } finally {
      runningRef.current = false
      setRunning(false)
    }
  }, [])

  return { running, run }
}

/** 列表动作除防止重复提交外，还公开当前正在处理的条目。 */
export function useKeyedAsyncAction<K>() {
  const [runningKey, setRunningKey] = useState<K | null>(null)
  const runningRef = useRef(false)

  const run = useCallback(async <T,>(key: K, action: () => Promise<T>): Promise<T | undefined> => {
    if (runningRef.current) return undefined
    runningRef.current = true
    setRunningKey(key)
    try {
      return await action()
    } finally {
      runningRef.current = false
      setRunningKey(null)
    }
  }, [])

  return { running: runningKey !== null, runningKey, run }
}
