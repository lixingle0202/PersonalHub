import { useCallback, useEffect, useRef, useState } from 'react'
import type { SaveState } from '../components/SaveStatus'

export function useAutosave<T>(save: (value: T) => Promise<unknown>, delay = 600) {
  const [state, setState] = useState<SaveState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const valueRef = useRef<T | null>(null)

  const flush = useCallback(async () => {
    if (valueRef.current === null) return
    const current = valueRef.current
    valueRef.current = null
    setState('saving')
    try {
      await save(current)
      setState('saved')
    } catch {
      valueRef.current = current
      setState('failed')
    }
  }, [save])

  const schedule = useCallback((value: T) => {
    valueRef.current = value
    setState('saving')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      void flush()
    }, delay)
  }, [delay, flush])

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  return { state, schedule, retry: flush }
}
