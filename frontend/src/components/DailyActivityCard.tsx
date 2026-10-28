import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Empty, Input, Modal, Space, Spin, Tag, Typography, message } from 'antd'
import { EditOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { apiRequest } from '../api/client'
import type { ActivityCategory, DailyActivity } from '../types'

const EMPTY: DailyActivity[] = []
const categories: Record<ActivityCategory, string> = {
  learning: '学习', diet: '饮食', exercise: '运动', work: '工作', health: '健康', life: '生活', leisure: '休闲', other: '其他',
}
type NarrationResult = { items: DailyActivity[]; skipped: string[]; created: boolean }
const errorText = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback

export function DailyActivityCard({ initialDate, initialItems = EMPTY }: { initialDate: string; initialItems?: DailyActivity[] }) {
  const today = dayjs().format('YYYY-MM-DD')
  const [date, setDate] = useState(initialDate)
  const [items, setItems] = useState(initialItems)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [skipped, setSkipped] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<DailyActivity | null>(null)
  const [deleting, setDeleting] = useState<DailyActivity | null>(null)
  const [changing, setChanging] = useState(false)
  const firstLoad = useRef(true)
  const request = useRef<{ date: string; text: string; id: string } | null>(null)
  const text = drafts[date] ?? ''
  const busy = saving || changing

  useEffect(() => {
    if (date === initialDate) setItems(initialItems)
  }, [initialItems, initialDate]) // Parent reloads provide a fresh snapshot of today.

  useEffect(() => {
    if (firstLoad.current) { firstLoad.current = false; return }
    const controller = new AbortController()
    setItems([])
    setLoading(true)
    setLoadError('')
    setSkipped([])
    apiRequest<DailyActivity[]>(`/daily-activities?date=${date}`, { signal: controller.signal })
      .then((rows) => { if (!controller.signal.aborted) setItems(rows) })
      .catch((reason) => { if (!controller.signal.aborted) setLoadError(errorText(reason, '读取记录失败')) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [date, reload])

  async function record() {
    const content = text.trim()
    if (!content || busy) return
    const targetDate = date
    if (request.current?.date !== date || request.current.text !== content) {
      request.current = { date, text: content, id: crypto.randomUUID() }
    }
    setSaving(true)
    setSkipped([])
    try {
      const result = await apiRequest<NarrationResult>('/daily-activities/narrate', {
        method: 'POST', body: JSON.stringify({ activity_date: targetDate, text: content, request_id: request.current.id }),
      })
      setSkipped(result.skipped)
      if (result.items.length) {
        setItems((current) => {
          const byId = new Map(current.map((item) => [item.id, item]))
          result.items.filter((item) => item.activity_date === targetDate).forEach((item) => byId.set(item.id, item))
          return [...byId.values()]
        })
        setDrafts((current) => current[targetDate]?.trim() === content ? { ...current, [targetDate]: '' } : current)
        request.current = null
        message.success(result.created ? `已分条记录 ${result.items.length} 件事` : '这次描述已保存，未重复添加')
      } else {
        message.info('没有可记录的已做事项，请调整描述后重试')
      }
    } catch (reason) {
      message.error(errorText(reason, '记录失败，请重试'))
    } finally { setSaving(false) }
  }

  async function saveEdit() {
    if (!editing?.content.trim() || changing) return
    setChanging(true)
    try {
      const updated = await apiRequest<DailyActivity>(`/daily-activities/${editing.id}`, {
        method: 'PATCH', body: JSON.stringify({ content: editing.content.trim(), category: editing.category, activity_date: editing.activity_date }),
      })
      setItems((current) => current.map((item) => item.id === updated.id ? updated : item).filter((item) => item.activity_date === date))
      setEditing(null)
      message.success(updated.activity_date === date ? '记录已修改' : `记录已移至 ${updated.activity_date}`)
    } catch (reason) { message.error(errorText(reason, '修改失败，请重试')) }
    finally { setChanging(false) }
  }

  async function remove() {
    if (!deleting || changing) return
    setChanging(true)
    try {
      await apiRequest(`/daily-activities/${deleting.id}`, { method: 'DELETE' })
      setItems((current) => current.filter((item) => item.id !== deleting.id))
      setDeleting(null)
      message.success('记录已删除，可在回收站恢复')
    } catch (reason) { message.error(errorText(reason, '删除失败，请重试')) }
    finally { setChanging(false) }
  }

  return <Card className="daily-activity-card" title={<span className="card-title-icon"><EditOutlined aria-hidden="true" />日常记录</span>}>
    <div className="journal-date-tools">
      <Space wrap>
        <label htmlFor="journal-date">查看日期</label>
        <input id="journal-date" aria-label="日常记录日期" type="date" className="native-form-select" value={date} max={today} disabled={busy} onChange={(event) => event.target.value && setDate(event.target.value)} />
        <Button disabled={busy} onClick={() => setDate(dayjs(date).subtract(1, 'day').format('YYYY-MM-DD'))}>前一天</Button>
        <Button disabled={busy || date >= today} onClick={() => setDate(dayjs(date).add(1, 'day').format('YYYY-MM-DD'))}>后一天</Button>
        <Button disabled={busy} onClick={() => setDate(today)}>回到今天</Button>
      </Space>
      <Typography.Text type="secondary">{date === today ? '今天' : date} · {items.length} 条记录</Typography.Text>
    </div>
    <Typography.Paragraph type="secondary">说说这一天实际做了什么，自动分条保存。学习、吃饭、运动、工作和生活小事都可以记录，整理后还能逐条修改。</Typography.Paragraph>
    <div className="journal-compose">
      <Input.TextArea aria-label="描述这一天做过的事情" rows={3} maxLength={5000} showCount value={text} disabled={saving} onChange={(event) => setDrafts((current) => ({ ...current, [date]: event.target.value }))} placeholder="例如：上午学了英语一小时，中午吃了牛肉面，下午跑步30分钟，晚上去超市买了牛奶。" />
      <div><Typography.Text type="secondary">记录到 {date}</Typography.Text><Button type="primary" loading={saving} disabled={!text.trim() || busy || loading || Boolean(loadError)} onClick={() => void record()}>整理并记录</Button></div>
    </div>
    {skipped.length ? <Alert type="info" showIcon title="以下内容含未完成或计划表述，未记入已做事项" description={skipped.join('；')} /> : null}
    {loadError ? <Alert type="error" title={loadError} action={<Button onClick={() => setReload((value) => value + 1)}>重新读取记录</Button>} />
      : loading ? <div className="journal-loading"><Spin /><span>正在读取这一天的记录</span></div>
        : items.length ? <ol className="daily-activity-list" aria-label="这一天的活动记录">
          {items.map((item) => <li key={item.id}>
            <div className="daily-activity-content"><Tag>{categories[item.category]}</Tag><Typography.Text>{item.content}</Typography.Text>
              <details><summary>查看原始描述</summary><p>{item.source_text}</p></details>
            </div>
            <Space wrap size={4}>
              <Button size="small" disabled={busy} aria-label={`修改日常记录：${item.content}`} onClick={() => setEditing({ ...item })}>修改</Button>
              <Button size="small" danger disabled={busy} aria-label={`删除日常记录：${item.content}`} onClick={() => setDeleting(item)}>删除</Button>
            </Space>
          </li>)}
        </ol> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这一天还没有日常记录" />}
    <Modal title="修改日常记录" open={Boolean(editing)} onCancel={() => !changing && setEditing(null)} onOk={() => void saveEdit()} okText="保存记录" cancelText="取消" confirmLoading={changing} okButtonProps={{ disabled: !editing?.content.trim() || !editing.activity_date }} cancelButtonProps={{ disabled: changing }}>
      {editing ? <div className="journal-editor">
        <label>记录日期<input type="date" aria-label="修改记录日期" className="native-form-select" value={editing.activity_date} max={today} onChange={(event) => setEditing({ ...editing, activity_date: event.target.value })} /></label>
        <label>分类<select aria-label="修改记录分类" className="native-form-select" value={editing.category} onChange={(event) => setEditing({ ...editing, category: event.target.value as ActivityCategory })}>{Object.entries(categories).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label>内容<Input.TextArea aria-label="修改记录内容" maxLength={5000} rows={4} value={editing.content} onChange={(event) => setEditing({ ...editing, content: event.target.value })} /></label>
      </div> : null}
    </Modal>
    <Modal title="删除日常记录" open={Boolean(deleting)} onCancel={() => !changing && setDeleting(null)} onOk={() => void remove()} okText="确认删除记录" cancelText="取消" confirmLoading={changing} okButtonProps={{ danger: true }} cancelButtonProps={{ disabled: changing }}>
      <Typography.Paragraph>确认删除“{deleting?.content}”？删除后可在回收站恢复。</Typography.Paragraph>
    </Modal>
  </Card>
}
