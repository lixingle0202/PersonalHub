import { ApiResponseError, apiRequest } from './client'

const RETRY_MS = 3000
const MAX_WAIT_MS = 10 * 60 * 1000

type GenerationJob<T> = {
  job_id: string; state: 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
  result: T | null; detail: string; queue_position: number
  elapsed_seconds?: number
}

export type SharedGenerationProgress = { state: string; queue_position: number; elapsed_seconds: number }
export type SharedGenerationHandle = { requestKey: string; jobId: string; startedAt: number }
export type SharedGenerationResume = Partial<SharedGenerationHandle> & {
  onHandle: (handle: SharedGenerationHandle) => void
  isCurrent?: () => boolean
}

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

async function boundedRequest<T>(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) controller.abort()
  const timer = window.setTimeout(abort, 20000)
  try {
    return await apiRequest<T>(path, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) throw new TypeError('连接共享模型服务超时，请检查网络后重试')
    throw error
  } finally {
    window.clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

export async function generateSharedDraft<T>(requirements: unknown, signal: AbortSignal, onWaiting: () => void, path = '/ai/learning/generate', onRunning?: () => void, onProgress?: (progress: SharedGenerationProgress) => void, resume?: SharedGenerationResume): Promise<T> {
  const started = resume?.startedAt ?? Date.now()
  const requestKey = resume?.requestKey ?? crypto.randomUUID()
  let jobId = resume?.jobId ?? ''
  let recoveryProbe = Boolean(jobId)
  let transientFailures = 0
  let terminal = false
  let cancellationSent = false
  const cancel = () => {
    if (resume?.isCurrent?.() === false) return
    if (jobId && !cancellationSent) {
      cancellationSent = true
      void apiRequest(`/ai/shared/jobs/${jobId}`, { method: 'DELETE' }).catch(() => undefined)
    }
  }
  signal.addEventListener('abort', cancel, { once: true })
  resume?.onHandle({ requestKey, jobId, startedAt: started })
  try {
  while (true) {
    if (signal.aborted || resume?.isCurrent?.() === false) throw new DOMException('Aborted', 'AbortError')
    if (!recoveryProbe && Date.now() - started >= MAX_WAIT_MS) {
      cancel()
      throw new Error('共享模型等待或生成时间过长，本次已停止，请缩短计划天数后重试')
    }
    try {
      const response = jobId
        ? await boundedRequest<GenerationJob<T>>(`/ai/shared/jobs/${jobId}`, signal)
        : await boundedRequest<T | GenerationJob<T>>(path, signal, {
          method: 'POST', body: JSON.stringify(requirements),
          headers: { Prefer: 'respond-async', 'X-Generation-Key': requestKey },
        })
      if (resume?.isCurrent?.() === false) throw new DOMException('Aborted', 'AbortError')
      recoveryProbe = false
      transientFailures = 0
      // Older/local services can still return a completed draft directly.
      if (!response || typeof response !== 'object' || !('job_id' in response)) return response as T
      const job = response as GenerationJob<T>
      jobId = job.job_id
      resume?.onHandle({ requestKey, jobId, startedAt: started })
      onProgress?.({ state: job.state, queue_position: job.queue_position ?? 0, elapsed_seconds: job.elapsed_seconds ?? Math.floor((Date.now() - started) / 1000) })
      if (job.state === 'completed') {
        terminal = true
        if (!job.result) throw new Error('未收到完整草稿，请重新生成')
        return job.result
      }
      if (job.state === 'failed') { terminal = true; throw new Error(job.detail || '共享模型生成失败，请重试') }
      if (job.state === 'cancelled' || job.state === 'cancelling') { terminal = true; throw new Error('这次生成已取消，可以重新生成') }
      if (job.state === 'queued') onWaiting()
      else onRunning?.()
      await pause(1500, signal)
    } catch (error) {
      const busy = error instanceof ApiResponseError && error.status === 429 && error.code === 'model_busy'
      const temporary = error instanceof TypeError || error instanceof ApiResponseError && [502, 503, 504, 520, 524].includes(error.status)
      if (!busy && (!temporary || ++transientFailures > 3)) throw error
      const remaining = MAX_WAIT_MS - (Date.now() - started)
      if (remaining <= 0) throw new Error('共享模型等待时间较长，请稍后再试，或切换为本地大模型')
      if (busy) onWaiting()
      await pause(Math.min(RETRY_MS, remaining), signal)
    }
  }
  } finally { signal.removeEventListener('abort', cancel); if (!terminal && (!resume || signal.aborted)) cancel() }
}
