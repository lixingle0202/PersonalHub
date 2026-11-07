import { useCallback, useEffect, useState } from 'react'
import { ArrowRightOutlined, CalendarOutlined, CheckOutlined, CoffeeOutlined, DeleteOutlined, EditOutlined, FlagOutlined, ReadOutlined } from '@ant-design/icons'
import { Button, Card, Col, Input, Progress, Row, Space, Statistic, Typography, message } from 'antd'
import dayjs from 'dayjs'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useSearchHighlight } from '../hooks/useSearchHighlight'
import { apiRequest } from '../api/client'
import { AgendaList } from '../components/AgendaList'
import { DailyActivityCard } from '../components/DailyActivityCard'
import { ErrorPanel, LoadingPanel } from '../components/StatePanels'
import type { AgendaItem, HomeData } from '../types'

const summaryMeta = {
  learning: ['学习计划', '/learning'],
  diet: ['饮食计划', '/diet'],
} as const

export function HomePage() {
  const [params] = useSearchParams()
  const today = dayjs().format('YYYY-MM-DD')
  const requestedDate = params.get('date')
  const requestedActivityDate = requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) && dayjs(requestedDate).format('YYYY-MM-DD') === requestedDate ? requestedDate : null
  const [data, setData] = useState<HomeData | null>(null)
  const activityDate = requestedActivityDate ?? data?.date ?? today
  useSearchHighlight(params.get('note') ? `note-${params.get('note')}` : null, Boolean(data))
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [editingNote, setEditingNote] = useState<{ id: string; content: string } | null>(null)
  const [savingNoteId, setSavingNoteId] = useState<string | null>(null)
  const [deletingNoteId, setDeletingNoteId] = useState<string | null>(null)
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  const navigate = useNavigate()

  const load = useCallback(async () => {
    try {
      setError('')
      setData(await apiRequest<HomeData>(`/home?date=${today}`))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取失败')
    }
  }, [today])

  useEffect(() => { void load() }, [load])

  async function toggleComplete(item: AgendaItem) {
    const action = item.status === 'completed' ? 'reopen' : 'complete'
    await apiRequest(`/agenda/${item.id}/${action}`, { method: 'POST' })
    await load()
  }

  async function addNote() {
    if (!note.trim()) return
    await apiRequest('/quick-notes', { method: 'POST', body: JSON.stringify({ content: note.trim() }) })
    setNote('')
    message.success('已记录')
    await load()
  }

  async function convertNote(id: string) {
    await apiRequest(`/quick-notes/${id}/convert`, {
      method: 'POST',
      body: JSON.stringify({ target_type: 'agenda', plan_date: today, bucket: 'scheduled' }),
    })
    await load()
  }

  async function updateNote() {
    if (!editingNote?.content.trim()) return
    setSavingNoteId(editingNote.id)
    try {
      await apiRequest(`/quick-notes/${editingNote.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: editingNote.content.trim() }),
      })
      setEditingNote(null)
      message.success('备忘已修改')
      await load()
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '修改失败，请重试')
    } finally {
      setSavingNoteId(null)
    }
  }

  async function deleteNote(id: string) {
    setDeletingNoteId(id)
    try {
      await apiRequest(`/quick-notes/${id}`, { method: 'DELETE' })
      if (editingNote?.id === id) setEditingNote(null)
      setConfirmingDeleteId(null)
      message.success('备忘已删除，可在回收站恢复')
      await load()
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '删除失败，请重试')
    } finally {
      setDeletingNoteId(null)
    }
  }

  if (error) return <ErrorPanel message={error} onRetry={() => void load()} />
  if (!data) return <LoadingPanel />

  return (
    <div className="page-stack">
      <section className="welcome-row" aria-label="今日概览">
        <div>
          <span className="eyebrow">每一天，都值得好好安排</span>
          <Typography.Title level={2}>今天，专注最重要的事</Typography.Title>
          <Typography.Text type="secondary">{dayjs().format('YYYY年MM月DD日')} · {['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][dayjs().day()]}</Typography.Text>
        </div>
        <div className="daily-progress"><Progress type="circle" percent={data.stats.completion_rate} size={88} strokeWidth={8} strokeColor="var(--primary-color)" railColor="var(--surface-line)" /><span>今日完成度</span></div>
      </section>
      <Row gutter={[16, 16]} className="summary-grid">
        <Col xs={24} sm={8}><Card className="summary-card"><span className="summary-icon summary-icon-blue"><CalendarOutlined aria-hidden="true" /></span><Statistic title="今日事项" value={data.stats.total} suffix={<span className="stat-unit">项</span>} /><span className="summary-caption">为今天留出清晰的节奏</span></Card></Col>
        <Col xs={24} sm={8}><Card className="summary-card"><span className="summary-icon summary-icon-green"><CheckOutlined aria-hidden="true" /></span><Statistic title="已经完成" value={data.stats.completed} suffix={<span className="stat-unit">项</span>} /><span className="summary-caption">每一小步，都算数</span></Card></Col>
        <Col xs={24} sm={8}><Card className="summary-card"><span className="summary-icon summary-icon-amber"><FlagOutlined aria-hidden="true" /></span><Statistic title="必须完成" value={data.stats.must} suffix={<span className="stat-unit">项</span>} /><span className="summary-caption">把精力放在重要的事上</span></Card></Col>
      </Row>
      <DailyActivityCard key={activityDate} initialDate={activityDate} initialItems={activityDate === data.date ? data.daily_activities : undefined} loadInitial={activityDate !== data.date} highlightId={params.get('activity')} />
      <Row gutter={[20, 20]} align="stretch" className="home-detail-grid">
        <Col xs={24} xl={15}>
          <Card title={<span className="card-title-icon"><CalendarOutlined aria-hidden="true" />今日计划</span>} extra={<Button type="link" onClick={() => navigate('/today')}>查看全部 <ArrowRightOutlined aria-hidden="true" /></Button>}>
            <div className="home-plan-overviews">
              {Object.entries(summaryMeta).map(([key, [label, path]]) => {
                const summary = data.summaries[key as keyof HomeData['summaries']]
                return (
                  <button type="button" className="home-plan-overview" key={key} onClick={() => navigate(path)}>
                    <span className="overview-label">{key === 'learning' ? <ReadOutlined aria-hidden="true" /> : <CoffeeOutlined aria-hidden="true" />}{label}<ArrowRightOutlined aria-hidden="true" /></span>
                    <Typography.Text strong>{summary.title}</Typography.Text>
                    {summary.detail ? <Typography.Text type="secondary">{summary.detail}</Typography.Text> : null}
                  </button>
                )
              })}
            </div>
            <Typography.Title level={5}>今天要完成（{data.agenda.length} 项）</Typography.Title>
            <AgendaList items={data.agenda} onToggleComplete={(item) => void toggleComplete(item)} compact />
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card className="notes-card" title={<span className="card-title-icon"><EditOutlined aria-hidden="true" />快速备忘</span>}>
            <Typography.Paragraph type="secondary" className="notes-caption">让灵感先落下来，稍后再慢慢安排。</Typography.Paragraph>
            <Space.Compact block>
              <Input aria-label="快速备忘内容" value={note} onChange={(event) => setNote(event.target.value)} onPressEnter={() => void addNote()} placeholder="随手记下一件事" />
              <Button type="primary" onClick={() => void addNote()}>记录</Button>
            </Space.Compact>
            <div className="note-list">
              {data.quick_notes.map((item) => (
                <div id={`note-${item.id}`} data-search-target={item.id === params.get('note')} className="note-row" key={item.id}>
                  {editingNote?.id === item.id ? <>
                    <Input
                      aria-label="编辑备忘内容"
                      value={editingNote.content}
                      onChange={(event) => setEditingNote({ ...editingNote, content: event.target.value })}
                      onPressEnter={() => void updateNote()}
                      autoFocus
                    />
                    <Space size={4} className="note-actions">
                      <Button size="small" type="primary" aria-label="保存备忘修改" loading={savingNoteId === item.id} disabled={!editingNote.content.trim()} onClick={() => void updateNote()}>保存</Button>
                      <Button size="small" aria-label="取消修改" disabled={savingNoteId === item.id} onClick={() => setEditingNote(null)}>取消</Button>
                    </Space>
                  </> : <>
                    <Typography.Text>{item.content}</Typography.Text>
                    <Space size={4} wrap className="note-actions">
                      {confirmingDeleteId === item.id ? <>
                        <Button size="small" danger aria-label={`确认删除备忘：${item.content}`} loading={deletingNoteId === item.id} onClick={() => void deleteNote(item.id)}>确认删除</Button>
                        <Button size="small" aria-label="取消删除" disabled={deletingNoteId === item.id} onClick={() => setConfirmingDeleteId(null)}>取消</Button>
                      </> : <>
                        <Button size="small" aria-label={`修改备忘：${item.content}`} icon={<EditOutlined aria-hidden="true" />} onClick={() => { setConfirmingDeleteId(null); setEditingNote({ id: item.id, content: item.content }) }}>修改</Button>
                        <Button size="small" danger aria-label={`删除备忘：${item.content}`} icon={<DeleteOutlined aria-hidden="true" />} onClick={() => setConfirmingDeleteId(item.id)}>删除</Button>
                        <Button size="small" onClick={() => void convertNote(item.id)}>加入今天</Button>
                      </>}
                    </Space>
                  </>}
                </div>
              ))}
              {!data.quick_notes.length ? <div className="notes-empty"><EditOutlined aria-hidden="true" /><span>一个想法，一件小事<br />都可以从这里开始</span></div> : null}
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  )
}
