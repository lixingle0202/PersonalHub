import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Card, DatePicker, Form, Input, Modal, Select, Space, Typography, message } from 'antd'
import dayjs, { Dayjs } from 'dayjs'
import { useSearchParams } from 'react-router-dom'
import { useSearchHighlight } from '../hooks/useSearchHighlight'
import { apiRequest } from '../api/client'
import { AgendaList } from '../components/AgendaList'
import { ErrorPanel, LoadingPanel } from '../components/StatePanels'
import type { AgendaItem } from '../types'

const groups = [
  ['must', '必须完成'],
  ['scheduled', '按时间安排'],
  ['optional', '有空再做'],
  ['completed', '已完成'],
] as const

type PlanValues = { title: string; bucket: string; priority: string; notes?: string; plan_date: string }

export function TodayPage() {
  const [params] = useSearchParams()
  const requestedDate = params.get('date')
  const validDate = requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) && dayjs(requestedDate).format('YYYY-MM-DD') === requestedDate ? requestedDate : null
  const [selectedDate, setSelectedDate] = useState<Dayjs>(() => dayjs(validDate ?? undefined))
  const [items, setItems] = useState<AgendaItem[] | null>(null)
  useEffect(() => { if (validDate) setSelectedDate(dayjs(validDate)) }, [validDate])
  useSearchHighlight(params.get('item') ? `agenda-${params.get('item')}` : null, Boolean(items))
  const [error, setError] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<AgendaItem | null>(null)
  const [deletingItem, setDeletingItem] = useState<AgendaItem | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [classifyingItem, setClassifyingItem] = useState<AgendaItem | null>(null)
  const [classificationSaving, setClassificationSaving] = useState(false)
  const [classificationForm] = Form.useForm()
  const [endOpen, setEndOpen] = useState(false)
  const [summary, setSummary] = useState('')
  const [form] = Form.useForm()
  const dateText = selectedDate.format('YYYY-MM-DD')

  const load = useCallback(async () => {
    try {
      setError('')
      setItems(await apiRequest<AgendaItem[]>(`/agenda?date=${dateText}`))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取失败')
    }
  }, [dateText])
  useEffect(() => { setItems(null); void load() }, [load])

  const grouped = useMemo(() => ({
    must: items?.filter((item) => item.bucket === 'must' && item.status === 'pending') ?? [],
    scheduled: items?.filter((item) => item.bucket === 'scheduled' && item.status === 'pending') ?? [],
    optional: items?.filter((item) => item.bucket === 'optional' && item.status === 'pending') ?? [],
    completed: items?.filter((item) => item.status === 'completed') ?? [],
  }), [items])

  function openEditor(item?: AgendaItem) {
    setEditingItem(item ?? null)
    form.resetFields()
    form.setFieldsValue(item ? { title: item.title, plan_date: item.plan_date, bucket: item.bucket, priority: item.priority, notes: item.notes }
      : { plan_date: dateText, bucket: 'scheduled', priority: 'normal', notes: '' })
    setCreateOpen(true)
  }

  async function savePlan(values: PlanValues) {
    if (saving) return
    setSaving(true)
    try {
      await apiRequest(editingItem ? `/agenda/${editingItem.id}` : '/agenda', {
        method: editingItem ? 'PATCH' : 'POST', body: JSON.stringify({ ...values, title: values.title.trim() }),
      })
      setCreateOpen(false)
      message.success(editingItem ? '计划已修改' : '计划已添加')
      await load()
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  async function deletePlan() {
    if (!deletingItem || deleting) return
    setDeleting(true)
    try {
      await apiRequest(`/agenda/${deletingItem.id}`, { method: 'DELETE' })
      setDeletingItem(null)
      message.success('计划已删除，可在回收站恢复')
      await load()
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '删除失败，请重试')
    } finally {
      setDeleting(false)
    }
  }

  function openClassification(item: AgendaItem) {
    classificationForm.setFieldsValue({ bucket: item.bucket, priority: item.priority })
    setClassifyingItem(item)
  }

  async function saveClassification(values: { bucket: string; priority: string }) {
    if (!classifyingItem || classificationSaving) return
    setClassificationSaving(true)
    try {
      await apiRequest(`/agenda/${classifyingItem.id}`, { method: 'PATCH', body: JSON.stringify(values) })
      setClassifyingItem(null)
      message.success('必要程度已更新')
      await load()
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '分类保存失败，请重试')
    } finally { setClassificationSaving(false) }
  }

  async function toggleComplete(item: AgendaItem) {
    const action = item.status === 'completed' ? 'reopen' : 'complete'
    await apiRequest(`/agenda/${item.id}/${action}`, { method: 'POST' })
    await load()
  }

  async function tomorrow(item: AgendaItem) {
    await apiRequest(`/agenda/${item.id}/reschedule`, {
      method: 'POST', body: JSON.stringify({ plan_date: selectedDate.add(1, 'day').format('YYYY-MM-DD') }),
    })
    message.success('已移到明天')
    await load()
  }

  async function reorder(ordered: AgendaItem[]) {
    setItems((current) => current ? [...current.filter((item) => !ordered.some((entry) => entry.id === item.id)), ...ordered] : current)
    await apiRequest('/agenda/reorder', { method: 'POST', body: JSON.stringify({ ordered_ids: ordered.map((item) => item.id) }) })
    await load()
  }

  async function endDay() {
    const pending = items?.filter((item) => item.status === 'pending') ?? []
    await apiRequest('/agenda/end-day', {
      method: 'POST',
      body: JSON.stringify({
        date: dateText,
        summary,
        actions: pending.map((item) => ({ item_id: item.id, action: 'tomorrow' })),
      }),
    })
    setEndOpen(false)
    message.success('今日已结束，未完成事项已移到明天')
    await load()
  }

  if (error) return <ErrorPanel message={error} onRetry={() => void load()} />
  if (!items) return <LoadingPanel />

  return (
    <div className="page-stack">
      <div className="page-actions">
        <Space>
          <DatePicker value={selectedDate} onChange={(value) => value && setSelectedDate(value)} allowClear={false} />
          <Button onClick={() => setSelectedDate(dayjs())}>回到今天</Button>
        </Space>
        <Space>
          <Button onClick={() => setEndOpen(true)}>结束今日</Button>
          <Button type="primary" onClick={() => openEditor()}>新增计划</Button>
        </Space>
      </div>
      {groups.map(([key, label]) => (
        <Card className={`agenda-group agenda-group-${key}`} title={<span className="agenda-group-title"><span className="group-dot" aria-hidden="true" />{label} · {grouped[key].length}</span>} key={key}>
          <AgendaList
            highlightId={params.get('item')}
            items={grouped[key]}
            onToggleComplete={(item) => void toggleComplete(item)}
            onRescheduleTomorrow={key === 'completed' ? undefined : (item) => void tomorrow(item)}
            onReorder={key === 'completed' ? undefined : (ordered) => void reorder(ordered)}
            onEdit={(item) => openEditor(item)}
            onDelete={setDeletingItem}
            onClassify={openClassification}
          />
        </Card>
      ))}

      <Modal forceRender title="调整必要程度" open={Boolean(classifyingItem)}
        onCancel={() => !classificationSaving && setClassifyingItem(null)} onOk={() => classificationForm.submit()}
        confirmLoading={classificationSaving} okText="保存分类" cancelText="取消"
        cancelButtonProps={{ disabled: classificationSaving }} closable={!classificationSaving}>
        <Typography.Paragraph>{classifyingItem?.title}</Typography.Paragraph>
        <Form form={classificationForm} layout="vertical" onFinish={(values) => void saveClassification(values)}>
          <Form.Item name="bucket" label="必要程度" rules={[{ required: true }]}>
            <select className="native-form-select"><option value="must">必须完成</option><option value="scheduled">按时间安排</option><option value="optional">有空再做</option></select>
          </Form.Item>
          <Form.Item name="priority" label="优先级" rules={[{ required: true }]}>
            <select className="native-form-select"><option value="low">低</option><option value="normal">普通</option><option value="high">高</option><option value="urgent">紧急</option></select>
          </Form.Item>
        </Form>
      </Modal>

      <Modal forceRender title={editingItem ? '编辑计划' : '新增计划'} open={createOpen} onCancel={() => !saving && setCreateOpen(false)} onOk={() => form.submit()} confirmLoading={saving} okText="保存" cancelText="取消" cancelButtonProps={{ disabled: saving }}>
        <Form form={form} layout="vertical" onFinish={(values) => void savePlan(values)}>
          <Form.Item name="title" label="计划内容" rules={[{ required: true, whitespace: true, message: '请输入计划内容' }]}><Input maxLength={300} /></Form.Item>
          <Form.Item name="plan_date" label="计划日期" rules={[{ required: true, message: '请选择日期' }]}><input type="date" className="native-form-select" /></Form.Item>
          <Form.Item name="bucket" label="分组"><Select options={[{ value: 'must', label: '必须完成' }, { value: 'scheduled', label: '按时间安排' }, { value: 'optional', label: '有空再做' }]} /></Form.Item>
          <Form.Item name="priority" label="优先级"><Select options={[{ value: 'normal', label: '普通' }, { value: 'high', label: '高' }, { value: 'urgent', label: '紧急' }]} /></Form.Item>
          <Form.Item name="notes" label="备注"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>

      <Modal title="删除计划" open={Boolean(deletingItem)} onCancel={() => !deleting && setDeletingItem(null)} onOk={() => void deletePlan()} confirmLoading={deleting} okText="确认删除" cancelText="取消" okButtonProps={{ danger: true }} cancelButtonProps={{ disabled: deleting }}>
        <Typography.Paragraph>确认删除“{deletingItem?.title}”？删除后可在数据与设置的回收站恢复。</Typography.Paragraph>
      </Modal>

      <Modal title="结束今日" open={endOpen} onCancel={() => setEndOpen(false)} onOk={() => void endDay()} okText="确认结束">
        <Typography.Paragraph>当前未完成的事项将统一移到明天。你可以在结束前单独取消或重新安排事项。</Typography.Paragraph>
        <Input.TextArea rows={4} value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="写一句今天的总结" />
      </Modal>
    </div>
  )
}
