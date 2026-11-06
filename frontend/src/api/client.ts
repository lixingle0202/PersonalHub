export type ApiErrorBody = { detail?: string | Array<{ msg?: string }>; code?: string }

let localToken = ''
let bootstrapInfo: Bootstrap | null = null
const READ_TTL_MS = 15_000
const readCache = new Map<string, { value: unknown; expires: number }>()
const pendingReads = new Map<string, Promise<unknown>>()
let readRevision = 0

export function clearApiCache() {
  ++readRevision
  readCache.clear()
  pendingReads.clear()
}

function cacheableRead(path: string, init: RequestInit) {
  return !init.signal && !init.headers && init.cache !== 'no-store'
    && /^\/(home\?|agenda(?:\?|$)|learning\/goals(?:\/[^/?]+)?$|diet\/(?:dishes|meals|shopping-lists|profile|health\/[^/?]+)(?:\?|$))/.test(path)
}

export type Bootstrap = {
  app_name: string
  version: string
  local_token: string
  database_path: string
  public_mode?: boolean
  desktop_mode?: boolean
  username?: string
}

export class AuthenticationRequired extends Error {
  constructor(message: string, readonly desktopMode = false) { super(message) }
}

export class ApiResponseError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message) }
}

export function isPublicMode() { return bootstrapInfo?.public_mode === true }
export function isDesktopMode() { return bootstrapInfo?.desktop_mode === true }
export function currentUsername() { return bootstrapInfo?.username ?? '' }

export async function bootstrapApi(): Promise<Bootstrap> {
  const response = await fetch('/api/v1/bootstrap')
  if (response.status === 401) {
    const body = await response.json().catch(() => ({})) as { desktop_mode?: boolean }
    throw new AuthenticationRequired('请先登录', body.desktop_mode === true)
  }
  if (!response.ok) throw new Error('无法连接本地数据服务')
  const data = await response.json() as Bootstrap
  clearApiCache()
  localToken = data.local_token
  bootstrapInfo = data
  return data
}

export function setLocalToken(token: string) {
  clearApiCache()
  localToken = token
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const cacheable = method === 'GET' && cacheableRead(path, init)
  if (cacheable) {
    const saved = readCache.get(path)
    if (saved && saved.expires > Date.now()) return structuredClone(saved.value) as T
    const pending = pendingReads.get(path)
    if (pending) return structuredClone(await pending) as T
  }
  // The overdue check is usually read-only. Invalidate only when it shifts a plan.
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method) && path !== '/learning/overdue/check'
  if (mutation) clearApiCache()
  const revision = readRevision
  const request = performRequest<T>(path, init, method)
  if (cacheable) pendingReads.set(path, request)
  try {
    const value = await request
    const shifted = (value as { shifted_goal_ids?: unknown })?.shifted_goal_ids
    if (path === '/learning/overdue/check' && Array.isArray(shifted) && shifted.length) clearApiCache()
    if (cacheable && revision === readRevision) {
      if (readCache.size >= 80) readCache.delete(readCache.keys().next().value!)
      readCache.set(path, { value: structuredClone(value), expires: Date.now() + READ_TTL_MS })
    }
    return value
  } finally {
    if (mutation) clearApiCache()
    if (pendingReads.get(path) === request) pendingReads.delete(path)
  }
}

async function performRequest<T>(path: string, init: RequestInit, method: string): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('X-Local-Token', localToken)

  const response = await fetch(`/api/v1${path}`, { ...init, headers })
  if (!response.ok) {
    let message = `操作失败（${response.status}）`
    let code: string | undefined
    try {
      const body = await response.json() as ApiErrorBody
      if (typeof body.detail === 'string') message = body.detail
      else if (Array.isArray(body.detail)) message = body.detail.map((item) => item.msg).filter(Boolean).join('；') || message
      if (typeof body.code === 'string') code = body.code
    } catch {
      // Keep the status-based message when the response is not JSON.
    }
    throw new ApiResponseError(message, response.status, code)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}
