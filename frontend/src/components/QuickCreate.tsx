import { useEffect, useState } from 'react'
import { DatePicker, Form, Input, Modal, Select, message } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { apiRequest } from '../api/client'

type Target = 'agenda' | 'note' | 'learning' | 'diet'
type Option = { id: string; name: string }

export function quickCreateEndpoint(target: Target, values: Record<string, unknown>): string {
  if (target === 'learning') return `/learning/goals/${values.parent_id}/tasks`
  return {
    agenda: '/agenda', note: '/quick-notes', diet: '/diet/meals', learning: '',
  }[target]
}

export const quickCreateTargets = [
  { value: 'agenda', label: '今日计划' }, { value: 'note', label: '快速备忘' },
  { value: 'learning', label: '学习任务' },
  { value: 'diet', label: '饮食安排' },
]

export function QuickCreate({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: () => void }) {
  const [target, setTarget] = useState<Target>('agenda')
  const [parents, setParents] = useState<Option[]>([])
  const [form] = Form.useForm()

  useEffect(() => {
    if (!open) return
    if (target === 'learning') void apiRequest<Array<{ id: string; name: string }>>('/learning/goals').then(setParents)
  }, [open, target])

  async function submit(values: Record<string, unknown>) {
    const dateValue = values.date as Dayjs | undefined
    const title = String(values.title ?? '').trim()
    let body: Record<string, unknown>
    if (target === 'note') body = { content: title }
    else if (target === 'agenda') body = { title, plan_date: dateValue?.format('YYYY-MM-DD') ?? dayjs().format('YYYY-MM-DD'), bucket: 'scheduled' }
    else if (target === 'learning') body = { title, plan_date: dateValue?.format('YYYY-MM-DD') }
    else body = { custom_name: title, meal_date: dateValue?.format('YYYY-MM-DD') ?? dayjs().format('YYYY-MM-DD'), meal_type: values.meal_type ?? 'dinner' }
    await apiRequest(quickCreateEndpoint(target, values), { method: 'POST', body: JSON.stringify(body) })
    message.success('已创建'); form.resetFields(); onClose(); onCreated?.()
  }

  return <Modal title="快速新增" open={open} onCancel={onClose} onOk={() => form.submit()} okText="创建">
    <Form form={form} layout="vertical" onFinish={(values) => void submit(values)} initialValues={{ target: 'agenda', date: dayjs(), meal_type: 'dinner' }}>
      <Form.Item label="添加到" name="target"><Select options={quickCreateTargets} onChange={(value: Target) => { setTarget(value); form.setFieldValue('parent_id', undefined) }} /></Form.Item>
      {target === 'learning' ? <Form.Item name="parent_id" label="学习目标" rules={[{ required: true }]}><Select options={parents.map((item) => ({ value: item.id, label: item.name }))} /></Form.Item> : null}
      <Form.Item name="title" label={target === 'diet' ? '餐食名称' : '标题或内容'} rules={[{ required: true }]}><Input /></Form.Item>
      {target !== 'note' ? <Form.Item name="date" label="日期"><DatePicker /></Form.Item> : null}
      {target === 'diet' ? <Form.Item name="meal_type" label="餐次"><Select options={[{ value: 'breakfast', label: '早餐' }, { value: 'lunch', label: '午餐' }, { value: 'dinner', label: '晚餐' }, { value: 'snack', label: '加餐' }]} /></Form.Item> : null}
    </Form>
  </Modal>
}
