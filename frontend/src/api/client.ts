export type ApiErrorBody = { detail?: string }

let localToken = ''

export type Bootstrap = {
  app_name: string
  version: string
  local_token: string
  database_path: string
}

export async function bootstrapApi(): Promise<Bootstrap> {
  const response = await fetch('/api/v1/bootstrap')
  if (!response.ok) throw new Error('无法连接本地数据服务')
  const data = await response.json() as Bootstrap
  localToken = data.local_token
  return data
}

export function setLocalToken(token: string) {
  localToken = token
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('X-Local-Token', localToken)

  const response = await fetch(`/api/v1${path}`, { ...init, headers })
  if (!response.ok) {
    let message = `操作失败（${response.status}）`
    try {
      const body = await response.json() as ApiErrorBody
      if (body.detail) message = body.detail
    } catch {
      // Keep the status-based message when the response is not JSON.
    }
    throw new Error(message)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}
