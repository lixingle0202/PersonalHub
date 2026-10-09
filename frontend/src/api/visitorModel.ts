import { currentUsername } from './client'

export type VisitorModelPreference = {
  provider: 'shared' | 'local'
  base_url: string
  model: string
}

const DEFAULT: VisitorModelPreference = { provider: 'shared', base_url: 'http://127.0.0.1:11434', model: '' }

function storageKey() { return `personalhub:visitor-model:${currentUsername()}` }

export function readVisitorModel(): VisitorModelPreference {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey()) ?? 'null') as Partial<VisitorModelPreference> | null
    if (!saved) return { ...DEFAULT }
    return {
      provider: saved.provider === 'local' ? 'local' : 'shared',
      base_url: typeof saved.base_url === 'string' ? saved.base_url : DEFAULT.base_url,
      model: typeof saved.model === 'string' ? saved.model : '',
    }
  } catch { return { ...DEFAULT } }
}

export function saveVisitorModel(preference: VisitorModelPreference) {
  localStorage.setItem(storageKey(), JSON.stringify(preference))
}

export function loopbackUrl(input: string): string {
  let url: URL
  try { url = new URL(input.trim()) } catch { throw new Error('请输入本机 Ollama 地址，例如 http://127.0.0.1:11434') }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('只允许本机 Ollama 地址，例如 http://127.0.0.1:11434')
  }
  return url.origin
}

async function localRequest(baseUrl: string, path: string, init: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${loopbackUrl(baseUrl)}${path}`, {
      ...init, mode: 'cors', credentials: 'omit', redirect: 'error',
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes('Ollama 地址')) throw error
    throw new Error('无法连接这台电脑的 Ollama。请确认服务已启动、浏览器允许本地网络访问，并将当前网页来源加入 OLLAMA_ORIGINS 后重启 Ollama。')
  }
  if (!response.ok) throw new Error(`本机 Ollama 返回错误（${response.status}），请检查模型是否已安装`)
  try { return await response.json() } catch { throw new Error('本机 Ollama 返回的数据无法读取') }
}

export async function visitorModels(baseUrl: string, signal?: AbortSignal): Promise<string[]> {
  const data = await localRequest(baseUrl, '/api/tags', { signal }) as { models?: Array<{ name?: string }> }
  if (!Array.isArray(data.models)) throw new Error('本机 Ollama 没有返回模型列表')
  return [...new Set(data.models.map((item) => item.name).filter((name): name is string => typeof name === 'string'))].sort()
}

export type VisitorModelReply = { content: string; done?: boolean; done_reason?: string }

export async function visitorGenerate(baseUrl: string, model: string, prepared: Record<string, unknown>, signal?: AbortSignal): Promise<VisitorModelReply> {
  const data = await localRequest(baseUrl, '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...prepared, model }), signal,
  }) as { message?: { content?: string }; done?: boolean; done_reason?: string }
  if (typeof data.message?.content !== 'string') throw new Error('本机模型没有返回学习计划，请换一个模型重试')
  return { content: data.message.content, done: data.done, done_reason: data.done_reason }
}
