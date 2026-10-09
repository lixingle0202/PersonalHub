import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, DatePicker, Input, InputNumber, Modal, Popconfirm, Space, Typography, message } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { apiRequest } from '../api/client'
import { AIDietGenerator } from './AIDietGenerator'

export type TemplateMeal = { day_number: number; meal_type: 'breakfast' | 'lunch' | 'dinner' | 'snack'; name: string; estimated_kcal: number }
export type DietTemplate = { id: string; name: string; description: string; cycle_days: number; builtin: boolean; meals: TemplateMeal[] }
export type TemplateDraft = Omit<DietTemplate, 'id' | 'builtin'>
const mealNames: Record<TemplateMeal['meal_type'], string> = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' }
const mealKeys = Object.fromEntries(Object.entries(mealNames).map(([key, value]) => [value, key])) as Record<string, TemplateMeal['meal_type']>

function linesFor(template: TemplateDraft) {
  return template.meals.map((meal) => `${meal.day_number} | ${mealNames[meal.meal_type]} | ${meal.name} | ${meal.estimated_kcal}`).join('\n')
}

function parseLines(input: string): TemplateMeal[] {
  return input.split('\n').map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const [day, type, name, kcal] = line.split('|').map((piece) => piece.trim())
    const meal_type = mealKeys[type] ?? (type as TemplateMeal['meal_type'])
    if (!Number.isInteger(Number(day)) || !mealNames[meal_type] || !name || !Number.isInteger(Number(kcal)) || Number(kcal) <= 0) {
      throw new Error(`第 ${index + 1} 行格式有误，请填写“天数 | 餐次 | 菜名 | kcal”`)
    }
    return { day_number: Number(day), meal_type, name, estimated_kcal: Number(kcal) }
  })
}

export function DietTemplates({ onImported }: { onImported: (startDate: Dayjs) => Promise<void> | void }) {
  const [templates, setTemplates] = useState<DietTemplate[]>([])
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<DietTemplate | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [cycleDays, setCycleDays] = useState(1)
  const [lines, setLines] = useState('')
  const [importing, setImporting] = useState<DietTemplate | null>(null)
  const [startDate, setStartDate] = useState(dayjs())
  const [days, setDays] = useState(7)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    try { setTemplates(await apiRequest<DietTemplate[]>('/diet/templates')); setError('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : '读取饮食模板失败') }
  }, [])
  useEffect(() => { void load() }, [load])

  function openEditor(template?: DietTemplate | TemplateDraft) {
    setEditing(template && 'id' in template && !template.builtin ? template : null)
    setName(template?.name ?? '我的饮食模板')
    setDescription(template?.description ?? '')
    setCycleDays(template?.cycle_days ?? 1)
    setLines(template ? linesFor(template) : '1 | 早餐 | 燕麦牛奶 | 400\n1 | 午餐 | 鸡肉蔬菜饭 | 650\n1 | 晚餐 | 番茄鸡蛋面 | 600')
    setEditorOpen(true); setError('')
  }

  async function save(importAfter: boolean) {
    if (busy) return
    setBusy(true); setError('')
    try {
      const payload = { name: name.trim(), description: description.trim(), cycle_days: cycleDays, meals: parseLines(lines) }
      if (!payload.name) throw new Error('请填写模板名称')
      const saved = await apiRequest<DietTemplate>(editing ? `/diet/templates/${editing.id}` : '/diet/templates', {
        method: editing ? 'PATCH' : 'POST', body: JSON.stringify(payload),
      })
      setEditorOpen(false); await load()
      if (importAfter) {
        const result = await apiRequest<{ imported: number; skipped: number }>(`/diet/templates/${encodeURIComponent(saved.id)}/import`, {
          method: 'POST', body: JSON.stringify({ start_date: dayjs().format('YYYY-MM-DD'), days: cycleDays }),
        })
        await onImported(dayjs())
        message.success(`已导入 ${result.imported} 餐，跳过已有的 ${result.skipped} 餐`)
      } else message.success('饮食模板已保存')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存模板失败') }
    finally { setBusy(false) }
  }

  async function importTemplate() {
    if (!importing || busy) return
    setBusy(true); setError('')
    try {
      const result = await apiRequest<{ imported: number; skipped: number }>(`/diet/templates/${encodeURIComponent(importing.id)}/import`, {
        method: 'POST', body: JSON.stringify({ start_date: startDate.format('YYYY-MM-DD'), days }),
      })
      setImporting(null); await onImported(startDate)
      message.success(`已导入 ${result.imported} 餐，跳过已有的 ${result.skipped} 餐`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '导入模板失败') }
    finally { setBusy(false) }
  }

  async function deleteTemplate(template: DietTemplate) {
    try {
      await apiRequest(`/diet/templates/${template.id}`, { method: 'DELETE' })
      await load(); message.success('模板已删除，已导入日历的餐食保留')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '删除模板失败') }
  }

  return <div className="page-stack">
    <div className="page-actions"><Typography.Text type="secondary">三日示例可以循环导入；导入会跳过已有餐次，热量均为粗估。</Typography.Text><Space><AIDietGenerator onGenerated={openEditor} /><Button type="primary" onClick={() => openEditor()}>手动创建模板</Button></Space></div>
    {error ? <Alert type="error" showIcon title={error} /> : null}
    <div className="diet-template-grid">{templates.map((template) => <Card key={template.id} title={template.name} extra={template.builtin ? '内置示例' : '我的模板'}>
      <Typography.Paragraph>{template.description}</Typography.Paragraph>
      <Typography.Text type="secondary">{template.cycle_days} 天循环 · 每日餐食和估算热量可在导入前查看</Typography.Text>
      <div className="diet-template-meals">{template.meals.map((meal) => <div key={`${meal.day_number}-${meal.meal_type}`}>第 {meal.day_number} 天 · {mealNames[meal.meal_type]}：{meal.name} · 约 {meal.estimated_kcal} kcal</div>)}</div>
      <Space wrap><Button type="primary" onClick={() => { setImporting(template); setStartDate(dayjs()); setDays(7); setError('') }}>导入日历</Button><Button onClick={() => openEditor(template)}>{template.builtin ? '复制并修改' : '修改模板'}</Button>{!template.builtin ? <Popconfirm title="删除此模板？" description="已导入日历的餐食会保留" okText="删除" cancelText="取消" onConfirm={() => void deleteTemplate(template)}><Button danger>删除模板</Button></Popconfirm> : null}</Space>
    </Card>)}</div>
    <Modal title={editing ? '修改饮食模板' : '创建饮食模板'} open={editorOpen} onCancel={() => { if (!busy) setEditorOpen(false) }} footer={<Space><Button onClick={() => setEditorOpen(false)}>取消</Button><Button loading={busy} onClick={() => void save(false)}>保存模板</Button><Button type="primary" loading={busy} onClick={() => void save(true)}>保存并导入日历</Button></Space>}>
      {error ? <Alert type="error" showIcon title={error} /> : null}
      <label className="template-field">模板名称<Input aria-label="模板名称" value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="template-field">说明<Input.TextArea aria-label="模板说明" value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      <label className="template-field">循环天数<InputNumber aria-label="循环天数" min={1} max={14} value={cycleDays} onChange={(value) => setCycleDays(value ?? 1)} /></label>
      <label className="template-field">餐食（每行：第几天 | 餐次 | 菜名 | kcal）<Input.TextArea aria-label="模板餐食" rows={8} value={lines} onChange={(event) => setLines(event.target.value)} /></label>
    </Modal>
    <Modal title={`导入「${importing?.name ?? ''}」`} open={Boolean(importing)} onCancel={() => setImporting(null)} onOk={() => void importTemplate()} okText="确认导入" confirmLoading={busy}>
      <Space orientation="vertical"><label>开始日期 <DatePicker aria-label="模板开始日期" value={startDate} onChange={(value) => { if (value) setStartDate(value) }} /></label><label>导入天数 <InputNumber aria-label="模板导入天数" min={1} max={31} value={days} onChange={(value) => setDays(value ?? 1)} /></label></Space>
      <Typography.Paragraph type="secondary">已有同日期同餐次会跳过，不会覆盖原有记录。</Typography.Paragraph>
    </Modal>
  </div>
}
