import { ApiResponseError, apiRequest } from './client'

const RETRY_MS = 3000
const MAX_WAIT_MS = 10 * 60 * 1000

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
    const done = () => { signal.removeEventListener('abort', cancel); resolve() }
    const timer = window.setTimeout(done, ms)
    const cancel = () => {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', cancel, { once: true })
  })
}

export async function generateSharedDraft<T>(requirements: unknown, signal: AbortSignal, onWaiting: () => void): Promise<T> {
  const started = Date.now()
  while (true) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    try {
      return await apiRequest<T>('/ai/learning/generate', {
        method: 'POST', signal, body: JSON.stringify(requirements),
      })
    } catch (error) {
      if (!(error instanceof ApiResponseError && error.status === 429 && error.code === 'model_busy')) throw error
      const remaining = MAX_WAIT_MS - (Date.now() - started)
      if (remaining <= 0) throw new Error('共享模型等待时间较长，请稍后再试，或切换为本地大模型')
      onWaiting()
      await pause(Math.min(RETRY_MS, remaining), signal)
    }
  }
}
