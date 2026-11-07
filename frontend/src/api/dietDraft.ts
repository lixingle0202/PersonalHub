import { apiRequest, currentUsername, isDesktopMode, isPublicMode } from './client'
import { generateSharedDraft, type SharedGenerationHandle, type SharedGenerationProgress } from './sharedModel'
import { visitorGenerate } from './visitorModel'
import type { TemplateDraft } from '../components/DietTemplates'

export type DietRequirements = { theme: string; preferences: string; days: number }
export type DietDraftEditor = { name: string; description: string; cycleDays: number; lines: string }
type Transport = 'shared' | 'visitor' | 'direct'
type Config = { base_url: string; model: string }
export type DietDraftState = {
  version: 1
  state: 'idle' | 'running' | 'queued' | 'completed' | 'failed' | 'cancelled'
  requirements?: DietRequirements
  transport?: Transport
  config?: Config
  handle?: SharedGenerationHandle
  progress?: SharedGenerationProgress
  plan?: TemplateDraft
  editor?: DietDraftEditor
  error?: string
}
type Entry = { value: DietDraftState; listeners: Set<() => void>; controller?: AbortController }
const entries = new Map<string, Entry>()
const empty = (): DietDraftState => ({ version: 1, state: 'idle' })
export function dietDraftScope() {
  return `personalhub:ai-diet-draft:v1:${isDesktopMode() ? 'desktop' : isPublicMode() ? 'public' : 'owner'}:${currentUsername()}`
}
function entryFor(key: string): Entry {
  let entry = entries.get(key)
  if (!entry) {
    let value = empty()
    try {
      const raw = sessionStorage.getItem(key)
      if (raw) {
        const saved = JSON.parse(raw) as DietDraftState
        if (saved.version === 1 && ['idle', 'running', 'queued', 'completed', 'failed', 'cancelled'].includes(saved.state)) value = saved
      }
    } catch { /* Storage may be unavailable; keep same-page recovery in memory. */ }
    entry = { value, listeners: new Set() }
    entries.set(key, entry)
  }
  return entry
}
function publish(key: string, value: DietDraftState) {
  const entry = entryFor(key)
  entry.value = value
  try {
    if (value.state === 'idle') sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, JSON.stringify(value))
  } catch { /* Retain the in-memory draft if browser storage is full/disabled. */ }
  entry.listeners.forEach((listener) => listener())
}
export function getDietDraft() { return entryFor(dietDraftScope()).value }
export function subscribeDietDraft(listener: () => void) {
  const entry = entryFor(dietDraftScope())
  entry.listeners.add(listener)
  return () => { entry.listeners.delete(listener) }
}
export function updateDietDraftEditor(editor: DietDraftEditor) {
  const key = dietDraftScope(), value = entryFor(key).value
  if (value.plan) publish(key, { ...value, editor })
}
export function discardDietDraft() {
  const key = dietDraftScope(), entry = entryFor(key)
  entry.controller?.abort()
  entry.controller = undefined
  publish(key, empty())
}
export function cancelDietGeneration() {
  const key = dietDraftScope(), entry = entryFor(key)
  if (!['running', 'queued'].includes(entry.value.state)) return
  entry.controller?.abort()
  publish(key, { ...entry.value, state: 'cancelled', error: '已取消生成，可以重新填写需求。' })
}
async function run(key: string) {
  const entry = entryFor(key)
  if (entry.controller || !entry.value.requirements) return
  const initial = entry.value
  const requirements = initial.requirements!
  const controller = new AbortController()
  entry.controller = controller
  const current = () => dietDraftScope() === key
  const active = () => current() && entry.controller === controller && !controller.signal.aborted
  const ensureActive = () => { if (!active()) throw new DOMException('Aborted', 'AbortError') }
  try {
    let result: { plan: TemplateDraft }
    if (initial.transport === 'shared') {
      result = await generateSharedDraft<{ plan: TemplateDraft }>(requirements, controller.signal, () => {
        if (active()) publish(key, { ...entry.value, state: 'queued' })
      }, '/ai/diet/generate', () => {
        if (active()) publish(key, { ...entry.value, state: 'running' })
      }, (progress) => {
        if (active()) publish(key, { ...entry.value, progress })
      }, { ...initial.handle, isCurrent: current, onHandle: (handle) => {
        if (active()) publish(key, { ...entry.value, handle })
      } })
    } else if (initial.transport === 'visitor') {
      if (!initial.config?.model) throw new Error('请先在数据与设置中选择本地模型')
      const prepared = await apiRequest<Record<string, unknown>>('/ai/diet/visitor/prepare', { method: 'POST', body: JSON.stringify(requirements), signal: controller.signal })
      ensureActive()
      const answer = await visitorGenerate(initial.config.base_url, initial.config.model, prepared, controller.signal)
      ensureActive()
      result = await apiRequest('/ai/diet/visitor/draft', { method: 'POST', body: JSON.stringify({ requirements, ...answer }), signal: controller.signal })
    } else {
      result = await apiRequest('/ai/diet/generate', { method: 'POST', body: JSON.stringify(requirements), signal: controller.signal })
    }
    ensureActive()
    if (!result?.plan?.meals?.length) throw new Error('未收到完整菜谱，请重新生成')
    publish(key, { ...entry.value, state: 'completed', plan: result.plan, error: undefined })
  } catch (reason) {
    if (active()) publish(key, { ...entry.value, state: 'failed', error: reason instanceof Error ? reason.message : '生成菜谱失败' })
  } finally {
    if (entry.controller === controller) entry.controller = undefined
  }
}
export function startDietGeneration(requirements: DietRequirements, config: Config, provider: 'shared' | 'local') {
  const key = dietDraftScope(), entry = entryFor(key)
  if (entry.controller || ['running', 'queued'].includes(entry.value.state)) return
  const transport: Transport = isDesktopMode() || isPublicMode() && provider === 'shared' ? 'shared'
    : isPublicMode() ? 'visitor' : 'direct'
  publish(key, { version: 1, state: 'running', requirements, transport, config })
  void run(key)
}
export function resumeDietGeneration() {
  const key = dietDraftScope(), entry = entryFor(key)
  if (entry.controller || !['running', 'queued'].includes(entry.value.state)) return
  if (entry.value.transport === 'shared') void run(key)
  else publish(key, { ...entry.value, state: 'failed', error: '页面已刷新，本机直连任务无法重新连接。请重新生成；普通页面切换不会中断任务。' })
}
