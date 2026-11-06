import { useEffect, useRef, useState } from 'react'
import { Alert, Button, DatePicker, Form, Input, InputNumber, Modal, Space, Tag, Typography, message } from 'antd'
import { BulbOutlined, DeleteOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { apiRequest, currentUsername, isPublicMode, isDesktopMode } from '../api/client'
import { generateSharedDraft, type SharedGenerationProgress } from '../api/sharedModel'
import { readVisitorModel, visitorGenerate, visitorModels } from '../api/visitorModel'
import type { OllamaSettings } from './OllamaSettingsPanel'

export type LearningPreview = {
  name: string; goal: string; start_date: string; target_date: string; daily_minutes: number
  sections: string[]
  tasks: Array<{ title: string; plan_date: string; section_index: number; minutes: number; notes: string }>
}
type Draft = { id: string; plan: LearningPreview; imported_goal_id: string | null }
type Requirements = { topic: string; objective: string; current_level: string; preferences?: string; start_date: Dayjs; days: number; daily_minutes: number }
const DRAFT_KEY = 'personalhub:ai-learning-draft'
function draftKey(hosted: boolean) { return hosted ? `${DRAFT_KEY}:${currentUsername()}` : DRAFT_KEY }

export function AILearningGenerator({ onImported, initialTopic = '', initialObjective = '' }: {
  onImported: (goalId: string) => Promise<void> | void
  initialTopic?: string
  initialObjective?: string
}) {
  const hosted = isPublicMode()
  const desktop = isDesktopMode()
  const [open, setOpen] = useState(false)
  const [config, setConfig] = useState<OllamaSettings | null>(null)
  const [provider, setProvider] = useState<'shared' | 'local'>(hosted ? 'shared' : 'local')
  const [connectionError, setConnectionError] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'load' | 'generate' | 'import' | ''>('')
  const [waitingForShared, setWaitingForShared] = useState(false)
  const [generationProgress, setGenerationProgress] = useState<SharedGenerationProgress | null>(null)
  const controller = useRef<AbortController | null>(null)
  const [form] = Form.useForm<Requirements>()

  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    controller.current = abort
    setBusy('load'); setError(''); setConnectionError(''); setConfig(null); setWaitingForShared(false)
    form.setFieldsValue({ topic: initialTopic, objective: initialObjective, current_level: '零基础', start_date: dayjs(), days: 7, daily_minutes: 45 })
    void (async () => {
      try {
        const preference = hosted ? readVisitorModel() : null
        const selectedProvider = desktop ? 'shared' : preference?.provider ?? 'local'
        setProvider(selectedProvider)
        const settings = hosted && selectedProvider === 'local'
          ? { base_url: preference!.base_url, model: preference!.model }
          : await apiRequest<OllamaSettings>('/ai/ollama/settings', { signal: abort.signal })
        setConfig(settings)
        const savedId = sessionStorage.getItem(draftKey(hosted))
        if (savedId) {
          try {
            const saved = await apiRequest<Draft>(`/ai/learning/drafts/${savedId}`, { signal: abort.signal })
            if (!saved.imported_goal_id) setDraft((current) => current?.id === saved.id ? current : saved)
            else { sessionStorage.removeItem(draftKey(hosted)); setDraft(null) }
          } catch { if (!abort.signal.aborted) setError('读取已保存的草稿失败，请重试；也可以重新生成') }
        }
        if (settings.model && selectedProvider === 'local') {
          const models = hosted ? await visitorModels(settings.base_url, abort.signal)
            : (await apiRequest<{ models: string[] }>('/ai/ollama/models', { method: 'POST', body: JSON.stringify({ base_url: settings.base_url }), signal: abort.signal })).models
          if (!models.includes(settings.model)) setConnectionError('保存的模型尚未安装，请在大模型设置中刷新并选择模型')
        }
      } catch (reason) { if (!abort.signal.aborted) setConnectionError(reason instanceof Error ? reason.message : '读取模型设置失败') }
      finally { if (!abort.signal.aborted) setBusy('') }
    })()
    return () => { abort.abort(); controller.current?.abort() }
  }, [open, form])

  function close() {
    if (busy === 'import') return
    controller.current?.abort()
    setBusy(''); setOpen(false); setError(''); setWaitingForShared(false)
  }

  async function generate(values: Requirements) {
    const abort = new AbortController()
    controller.current = abort
    setBusy('generate'); setError(''); setWaitingForShared(false); setGenerationProgress(null)
    try {
      const requirements = { ...values, start_date: values.start_date.format('YYYY-MM-DD') }
      let generated: Draft
      if (hosted && provider === 'local') {
        if (!config?.model) throw new Error('请先在数据与设置中选择本地模型')
        const prepared = await apiRequest<Record<string, unknown>>('/ai/learning/visitor/prepare', {
          method: 'POST', signal: abort.signal, body: JSON.stringify(requirements),
        })
        const result = await visitorGenerate(config.base_url, config.model, prepared, abort.signal)
        generated = await apiRequest<Draft>('/ai/learning/visitor/draft', {
          method: 'POST', signal: abort.signal, body: JSON.stringify({ requirements, ...result }),
        })
      } else {
        generated = hosted
          ? await generateSharedDraft<Draft>(requirements, abort.signal, () => setWaitingForShared(true), '/ai/learning/generate', () => setWaitingForShared(false), setGenerationProgress)
          : await apiRequest<Draft>('/ai/learning/generate', {
            method: 'POST', signal: abort.signal, body: JSON.stringify(requirements),
          })
      }
      if (!abort.signal.aborted) { setDraft(generated); sessionStorage.setItem(draftKey(hosted), generated.id) }
    } catch (reason) { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : '生成失败，请重试') }
    finally { if (!abort.signal.aborted) { setBusy(''); setWaitingForShared(false) } }
  }

  function editPlan(update: (plan: LearningPreview) => LearningPreview) {
    setDraft((current) => current ? { ...current, plan: update(current.plan) } : null)
    setError('')
  }

  async function importPlan() {
    if (!draft) return
    if (!draft.plan.name.trim() || !draft.plan.goal.trim() || !draft.plan.tasks.length || draft.plan.tasks.some((task) => !task.title.trim())) {
      setError('请填写计划名称、目标和任务标题，并至少保留一个任务'); return
    }
    setBusy('import'); setError('')
    try {
      const result = await apiRequest<{ id: string }>(`/ai/learning/drafts/${draft.id}/import`, { method: 'POST', body: JSON.stringify(draft.plan) })
      sessionStorage.removeItem(draftKey(hosted))
      setDraft(null); setOpen(false)
      await onImported(result.id)
      message.success('学习计划已加入，按日期同步到首页和今日计划')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '导入失败，可重试') }
    finally { setBusy('') }
  }

  const plan = draft?.plan
  return <>
    <Button aria-label="AI 生成学习计划" icon={<BulbOutlined aria-hidden />} onClick={() => setOpen(true)}>AI 生成学习计划</Button>
    <Modal width={900} title="AI 生成学习计划" open={open} onCancel={close} footer={null} mask={{ closable: false }}>
      <div className="ai-generator">
        <div className="ai-connection"><Typography.Text type="secondary">{desktop ? '本机 AI' : provider === 'shared' ? '共享大模型' : '本地大模型'}{config?.model ? ` · ${config.model}` : ''}</Typography.Text><a href="/settings?tab=ai">大模型设置</a></div>
        {!config?.model && busy !== 'load' ? <Alert type="info" showIcon title={provider === 'shared' ? '共享模型暂不可用' : '请先配置本地模型'} description={provider === 'shared' ? '请稍后重试。' : '在数据与设置 → 大模型中检查连接、选择模型并保存，再打开这个窗口。'} /> : null}
        {connectionError ? <Alert type="warning" showIcon title={connectionError} /> : null}
        {error ? <Alert type="error" showIcon title={error} /> : null}
        {plan ? <>
          <Alert type="info" showIcon title="这是可编辑草稿，确认前不会加入正式计划" description={`${plan.start_date} 至 ${plan.target_date}，每日最多 ${plan.daily_minutes} 分钟。可以修改内容、日期、时长，或移除不需要的任务。`} />
          <div className="ai-preview-heading"><label htmlFor="ai-plan-name">计划名称</label><Input id="ai-plan-name" value={plan.name} onChange={(event) => editPlan((value) => ({ ...value, name: event.target.value }))} /><label htmlFor="ai-plan-goal">学习目标描述</label><Input.TextArea id="ai-plan-goal" value={plan.goal} rows={2} onChange={(event) => editPlan((value) => ({ ...value, goal: event.target.value }))} /></div>
          <div className="ai-sections">{plan.sections.map((section, index) => <div className="ai-section-row" key={index}><Input aria-label={`章节 ${index + 1}`} prefix={<Tag>{index + 1}</Tag>} value={section} onChange={(event) => editPlan((value) => ({ ...value, sections: value.sections.map((name, offset) => offset === index ? event.target.value : name) }))} /><Button danger icon={<DeleteOutlined />} aria-label={`移除章节 ${index + 1}`} onClick={() => editPlan((value) => ({ ...value, sections: value.sections.filter((_, offset) => offset !== index), tasks: value.tasks.filter((task) => task.section_index !== index).map((task) => ({ ...task, section_index: task.section_index > index ? task.section_index - 1 : task.section_index })) }))} /></div>)}</div>
          <div className="ai-task-preview">{plan.tasks.map((task, index) => <div className="ai-task-card" key={index}>
            <div className="ai-task-row"><DatePicker aria-label={`任务 ${index + 1} 日期`} value={dayjs(task.plan_date)} allowClear={false} disabledDate={(date) => date.isBefore(plan.start_date, 'day') || date.isAfter(plan.target_date, 'day')} onChange={(date) => { if (date) editPlan((value) => ({ ...value, tasks: value.tasks.map((entry, offset) => offset === index ? { ...entry, plan_date: date.format('YYYY-MM-DD') } : entry) })) }} /><Tag>{plan.sections[task.section_index]}</Tag><InputNumber aria-label={`任务 ${index + 1} 分钟`} min={1} max={plan.daily_minutes} value={task.minutes} onChange={(minutes) => editPlan((value) => ({ ...value, tasks: value.tasks.map((entry, offset) => offset === index ? { ...entry, minutes: minutes ?? 1 } : entry) }))} /><Typography.Text type="secondary">分钟</Typography.Text><Button type="text" danger icon={<DeleteOutlined />} aria-label={`移除任务 ${index + 1}`} onClick={() => editPlan((value) => ({ ...value, tasks: value.tasks.filter((_, offset) => offset !== index) }))} /></div>
            <Input aria-label={`任务 ${index + 1} 标题`} value={task.title} onChange={(event) => editPlan((value) => ({ ...value, tasks: value.tasks.map((entry, offset) => offset === index ? { ...entry, title: event.target.value } : entry) }))} />
            <Input.TextArea aria-label={`任务 ${index + 1} 说明`} rows={2} value={task.notes} onChange={(event) => editPlan((value) => ({ ...value, tasks: value.tasks.map((entry, offset) => offset === index ? { ...entry, notes: event.target.value } : entry) }))} />
          </div>)}</div>
          <div className="ai-generator-actions"><Button disabled={Boolean(busy)} onClick={() => { setDraft(null); sessionStorage.removeItem(draftKey(hosted)); setError('') }}>重新填写需求</Button><Space><Button aria-label="取消" disabled={busy === 'import'} onClick={close}>取消</Button><Button type="primary" loading={busy === 'import'} disabled={Boolean(busy) || !plan.tasks.length} onClick={() => void importPlan()}>确认加入学习计划</Button></Space></div>
        </> : <Form form={form} layout="vertical" onFinish={(values) => void generate(values)}>
          <Form.Item name="topic" label="学习主题" rules={[{ required: true, whitespace: true, message: '请输入学习主题' }]}><Input placeholder="例如：Android 开发、Python、大学物理" maxLength={200} /></Form.Item>
          <Form.Item name="objective" label="希望达到的目标" rules={[{ required: true, whitespace: true, message: '请描述希望达到的目标' }]}><Input.TextArea rows={2} placeholder="例如：独立完成一个待办清单 Android 应用" maxLength={2000} /></Form.Item>
          <Form.Item name="current_level" label="目前基础"><Input placeholder="例如：会 Java，尚未接触 Android" maxLength={1000} /></Form.Item>
          <div className="ai-request-schedule"><Form.Item name="start_date" label="开始日期" rules={[{ required: true }]}><DatePicker /></Form.Item><Form.Item name="days" label="计划天数" rules={[{ required: true }]}><InputNumber min={1} max={30} /></Form.Item><Form.Item name="daily_minutes" label="每天可用分钟" rules={[{ required: true }]}><InputNumber min={5} max={480} /></Form.Item></div>
          <Form.Item name="preferences" label="补充要求"><Input.TextArea rows={2} placeholder="例如：多安排动手练习，每三天复习一次" maxLength={2000} /></Form.Item>
          {busy === 'generate' ? <Alert type="info" showIcon title={waitingForShared ? `正在排队${generationProgress?.queue_position ? ` · 第 ${generationProgress.queue_position} 位` : ''}` : provider === 'shared' ? `${desktop ? '本机 AI' : '共享模型'}正在生成${generationProgress ? ` · 已用 ${generationProgress.elapsed_seconds} 秒` : ''}` : '本地模型正在生成，请稍候'} description={waitingForShared ? '轮到后自动开始，可以取消。' : '完成后自动显示草稿，可随时取消。'} className="ai-status" /> : null}
          <div className="ai-generator-actions"><Typography.Text type="secondary">生成后先预览，再由你确认加入</Typography.Text><Space><Button aria-label="取消等待" onClick={close}>{busy === 'generate' ? '取消等待' : '取消'}</Button><Button type="primary" htmlType="submit" loading={busy === 'generate'} disabled={Boolean(busy) || !config?.model || Boolean(connectionError)}>生成草稿</Button></Space></div>
        </Form>}
      </div>
    </Modal>
  </>
}
