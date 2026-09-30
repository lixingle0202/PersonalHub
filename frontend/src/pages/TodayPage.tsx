import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Card, DatePicker, Form, Input, Modal, Select, Space, Typography, message } from 'antd'
import dayjs, { Dayjs } from 'dayjs'
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

export function TodayPage() {
  const [selectedDate, setSelectedDate] = useState<Dayjs>(dayjs())
  const [items, setItems] = useState<AgendaItem[] | null>(null)
  const [error, setError] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
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

  async function create(values: { title: string; bucket: string; priority: string; notes?: string }) {
    await apiRequest('/agenda', { method: 'POST', body: JSON.stringify({ ...values, plan_date: dateText }) })
    form.resetFields()
    setCreateOpen(false)
    await load()
  }

  async function complete(item: AgendaItem) {
    await apiRequest(`/agenda/${item.id}/complete`, { method: 'POST' })
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
          <Button type="primary" onClick={() => setCreateOpen(true)}>新增计划</Button>
        </Space>
      </div>
      {groups.map(([key, label]) => (
        <Card title={`${label} · ${grouped[key].length}`} key={key}>
          <AgendaList
            items={grouped[key]}
            onComplete={key === 'completed' ? undefined : (item) => void complete(item)}
            onRescheduleTomorrow={key === 'completed' ? undefined : (item) => void tomorrow(item)}
            onReorder={key === 'completed' ? undefined : (ordered) => void reorder(ordered)}
          />
        </Card>
      ))}

      <Modal title="新增计划" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={() => form.submit()} okText="保存">
        <Form form={form} layout="vertical" onFinish={(values) => void create(values)} initialValues={{ bucket: 'scheduled', priority: 'normal' }}>
          <Form.Item name="title" label="计划内容" rules={[{ required: true, message: '请输入计划内容' }]}><Input /></Form.Item>
          <Form.Item name="bucket" label="分组"><Select options={[{ value: 'must', label: '必须完成' }, { value: 'scheduled', label: '按时间安排' }, { value: 'optional', label: '有空再做' }]} /></Form.Item>
          <Form.Item name="priority" label="优先级"><Select options={[{ value: 'normal', label: '普通' }, { value: 'high', label: '高' }, { value: 'urgent', label: '紧急' }]} /></Form.Item>
          <Form.Item name="notes" label="备注"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>

      <Modal title="结束今日" open={endOpen} onCancel={() => setEndOpen(false)} onOk={() => void endDay()} okText="确认结束">
        <Typography.Paragraph>当前未完成的事项将统一移到明天。你可以在结束前单独取消或重新安排事项。</Typography.Paragraph>
        <Input.TextArea rows={4} value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="写一句今天的总结" />
      </Modal>
    </div>
  )
}
