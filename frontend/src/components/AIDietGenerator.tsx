import { useEffect, useState } from 'react'
import { Alert, Button, Card, Form, Input, InputNumber, Modal, Space, Typography } from 'antd'
import { apiRequest, isPublicMode, isDesktopMode } from '../api/client'
import { cancelDietGeneration, discardDietDraft, getDietDraft, startDietGeneration, type DietRequirements } from '../api/dietDraft'
import { useDietDraft } from '../hooks/useDietDraft'
import { readVisitorModel, visitorModels } from '../api/visitorModel'
import type { TemplateDraft } from './DietTemplates'

type ModelConfig = { base_url: string; model: string }

export function DietDraftNotice({ onOpen }: { onOpen: () => void }) {
  const draft = useDietDraft()
  if (draft.state === 'idle') return null
  const busy = ['running', 'queued'].includes(draft.state)
  const title = draft.state === 'queued' ? `AI 菜谱正在排队${draft.progress?.queue_position ? ` · 第 ${draft.progress.queue_position} 位` : ''}`
    : busy ? `AI 菜谱正在生成${draft.progress ? ` · 已用 ${draft.progress.elapsed_seconds} 秒` : ''}`
      : draft.plan ? 'AI 菜谱草稿已保留，可以继续编辑' : draft.error ?? 'AI 菜谱生成已结束'
  return <Alert type={draft.state === 'failed' ? 'warning' : 'info'} showIcon title={title} action={<Button onClick={onOpen}>{busy ? '查看进度' : '查看菜谱草稿'}</Button>} />
}

export function AIDietGenerator({ onGenerated, openRequest = 0 }: { onGenerated: (plan: TemplateDraft) => void; openRequest?: number }) {
  const hosted = isPublicMode(), desktop = isDesktopMode()
  const draft = useDietDraft()
  const [open, setOpen] = useState(false)
  const [config, setConfig] = useState<ModelConfig | null>(null)
  const [provider, setProvider] = useState<'shared' | 'local'>(hosted ? 'shared' : 'local')
  const [connectionError, setConnectionError] = useState('')
  const [form] = Form.useForm<DietRequirements>()
  const busy = draft.state === 'running' || draft.state === 'queued'
  const preview = draft.plan
  useEffect(() => { if (openRequest && !getDietDraft().editor) setOpen(true) }, [openRequest])

  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    form.setFieldsValue(getDietDraft().requirements ?? { theme: '一日均衡菜谱', preferences: '', days: 1 })
    setConnectionError(''); setConfig(null)
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
      } catch (reason) { if (!abort.signal.aborted) setConnectionError(reason instanceof Error ? reason.message : '读取模型设置失败') }
    })()
    // Settings belong to this modal; the generation task survives unmount.
    return () => abort.abort()
  }, [open, form, hosted, desktop])

  function generate(values: DietRequirements) {
    if (config?.model) startDietGeneration(values, config, provider)
  }

  return <><Button onClick={() => setOpen(true)}>AI 生成菜谱 / 模板</Button>
    <Modal title="AI 生成饮食菜单" width={760} open={open} onCancel={() => setOpen(false)} footer={preview ? <Space><Button onClick={discardDietDraft}>重新生成</Button><Button type="primary" onClick={() => { onGenerated(preview); setOpen(false) }}>编辑、保存或导入日历</Button></Space> : null}>
      <Typography.Paragraph type="secondary">{desktop ? '使用本机 AI' : `使用${provider === 'shared' ? '共享' : '本地'}大模型`}{(busy ? draft.config?.model : config?.model) ? ` · ${busy ? draft.config?.model : config?.model}` : ''}。生成后先核对再保存。</Typography.Paragraph>
      {connectionError ? <Alert type="warning" showIcon title={connectionError} /> : null}
      {draft.error ? <Alert type={draft.state === 'failed' ? 'error' : 'info'} showIcon title={draft.error} /> : null}
      {busy ? <Alert type="info" showIcon title={draft.state === 'queued' ? `正在排队${draft.progress?.queue_position ? ` · 第 ${draft.progress.queue_position} 位` : ''}` : `正在生成${draft.progress ? ` · 已用 ${draft.progress.elapsed_seconds} 秒` : ''}`} description="可以切换页面，返回后继续查看。" /> : null}
      {preview ? <div className="ai-diet-preview"><Typography.Title level={4}>{preview.name}</Typography.Title><Typography.Paragraph>{preview.description}</Typography.Paragraph>{preview.meals.map((meal) => <Card size="small" key={`${meal.day_number}-${meal.meal_type}`}>第 {meal.day_number} 天 · {{ breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' }[meal.meal_type]}：{meal.name} · 约 {meal.estimated_kcal} kcal</Card>)}</div>
        : <Form form={form} layout="vertical" onFinish={generate}>
          <Form.Item name="theme" label="菜谱主题" rules={[{ required: true }]}><Input disabled={busy} placeholder="如备考周、均衡饮食" /></Form.Item>
          <Form.Item name="days" label="生成天数" rules={[{ required: true }]}><InputNumber disabled={busy} min={1} max={7} /></Form.Item>
          <Form.Item name="preferences" label="口味、预算或需避开的食材"><Input.TextArea disabled={busy} rows={3} placeholder="填写偏好及需避开的食材" /></Form.Item>
          <Space wrap><Button onClick={() => setOpen(false)}>{busy ? '收起，继续生成' : '关闭'}</Button>{busy ? <Button danger onClick={cancelDietGeneration}>取消生成</Button> : <Button type="primary" htmlType="submit" disabled={!config?.model}>生成可编辑草稿</Button>}</Space>
        </Form>}
    </Modal>
  </>
}
