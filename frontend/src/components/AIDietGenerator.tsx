import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Form, Input, InputNumber, Modal, Space, Typography } from 'antd'
import { apiRequest, isPublicMode, isDesktopMode } from '../api/client'
import { generateSharedDraft } from '../api/sharedModel'
import { readVisitorModel, visitorGenerate, visitorModels } from '../api/visitorModel'
import type { TemplateDraft } from './DietTemplates'

type Requirements = { theme: string; preferences: string; days: number }
type Result = { plan: TemplateDraft }
type ModelConfig = { base_url: string; model: string }

export function AIDietGenerator({ onGenerated }: { onGenerated: (plan: TemplateDraft) => void }) {
  const hosted = isPublicMode()
  const desktop = isDesktopMode()
  const [open, setOpen] = useState(false)
  const [config, setConfig] = useState<ModelConfig | null>(null)
  const [provider, setProvider] = useState<'shared' | 'local'>(hosted ? 'shared' : 'local')
  const [preview, setPreview] = useState<TemplateDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState('')
  const [form] = Form.useForm<Requirements>()
  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    form.setFieldsValue({ theme: '一日均衡菜谱', preferences: '', days: 1 })
    setPreview(null); setError(''); setConfig(null)
    void (async () => {
      try {
        const preference = hosted ? readVisitorModel() : null
        const selectedProvider = desktop ? 'shared' : preference?.provider ?? 'local'
        setProvider(selectedProvider)
        const settings = hosted && selectedProvider === 'local'
          ? { base_url: preference!.base_url, model: preference!.model }
          : await apiRequest<ModelConfig>('/ai/ollama/settings', { signal: abort.signal })
        if (selectedProvider === 'local' && settings.model) {
          const models = hosted ? await visitorModels(settings.base_url, abort.signal)
            : (await apiRequest<{ models: string[] }>('/ai/ollama/models', { method: 'POST', body: JSON.stringify({ base_url: settings.base_url }), signal: abort.signal })).models
          if (!models.includes(settings.model)) throw new Error('本地模型尚未安装，请在大模型设置中刷新并选择模型')
        }
        if (!abort.signal.aborted) setConfig(settings)
      } catch (reason) { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : '读取模型设置失败') }
    })()
    return () => abort.abort()
  }, [open, form, hosted])

  async function generate(values: Requirements) {
    const abort = new AbortController()
    controller.current = abort
    setBusy(true); setWaiting(false); setError('')
    try {
      let result: Result
      if (hosted && provider === 'local') {
        if (!config?.model) throw new Error('请先在数据与设置中选择本地模型')
        const prepared = await apiRequest<Record<string, unknown>>('/ai/diet/visitor/prepare', { method: 'POST', body: JSON.stringify(values), signal: abort.signal })
        const answer = await visitorGenerate(config.base_url, config.model, prepared, abort.signal)
        result = await apiRequest<Result>('/ai/diet/visitor/draft', { method: 'POST', body: JSON.stringify({ requirements: values, ...answer }), signal: abort.signal })
      } else if (hosted) {
        result = await generateSharedDraft<Result>(values, abort.signal, () => setWaiting(true), '/ai/diet/generate', () => setWaiting(false))
      } else {
        result = await apiRequest<Result>('/ai/diet/generate', { method: 'POST', body: JSON.stringify(values), signal: abort.signal })
      }
      if (!abort.signal.aborted) setPreview(result.plan)
    } catch (reason) { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : '生成菜谱失败') }
    finally { if (!abort.signal.aborted) { setBusy(false); setWaiting(false) } }
  }

  function close() { controller.current?.abort(); setBusy(false); setOpen(false); setWaiting(false) }

  return <><Button onClick={() => setOpen(true)}>AI 生成菜谱 / 模板</Button>
    <Modal title="AI 生成饮食菜单" width={760} open={open} onCancel={close} footer={preview ? <Space><Button onClick={() => setPreview(null)}>重新生成</Button><Button type="primary" onClick={() => { onGenerated(preview); close() }}>编辑、保存或导入日历</Button></Space> : null}>
      <Typography.Paragraph type="secondary">{desktop ? '使用本机 AI' : `使用${provider === 'shared' ? '共享' : '本地'}大模型`}{config?.model ? ` · ${config.model}` : ''}。生成内容和热量都需核对食材、份量及个人过敏情况。</Typography.Paragraph>
      {error ? <Alert type="error" showIcon title={error} /> : null}
      {waiting ? <Alert type="info" showIcon title="共享模型忙碌，正在等待并重试" /> : null}
      {!config?.model && !error ? <Alert type="info" showIcon title="请先在数据与设置中配置大模型" /> : null}
      {preview ? <div className="ai-diet-preview"><Typography.Title level={4}>{preview.name}</Typography.Title><Typography.Paragraph>{preview.description}</Typography.Paragraph>{preview.meals.map((meal) => <Card size="small" key={`${meal.day_number}-${meal.meal_type}`}>第 {meal.day_number} 天 · {{ breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' }[meal.meal_type]}：{meal.name} · 约 {meal.estimated_kcal} kcal</Card>)}</div>
        : <Form form={form} layout="vertical" onFinish={(values) => void generate(values)}>
          <Form.Item name="theme" label="菜谱主题" rules={[{ required: true }]}><Input placeholder="如备考周、均衡饮食" /></Form.Item>
          <Form.Item name="days" label="生成天数" rules={[{ required: true }]}><InputNumber min={1} max={7} /></Form.Item>
          <Form.Item name="preferences" label="口味、预算或需避开的食材"><Input.TextArea rows={3} placeholder="请写清需要避开的食材，并在导入前自行核对" /></Form.Item>
          <Space><Button onClick={close}>{busy ? '取消等待' : '取消'}</Button><Button type="primary" htmlType="submit" loading={busy} disabled={!config?.model || busy}>生成可编辑草稿</Button></Space>
        </Form>}
    </Modal>
  </>
}
