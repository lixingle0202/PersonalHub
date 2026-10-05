import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Col, Input, Progress, Row, Space, Statistic, Typography, message } from 'antd'
import dayjs from 'dayjs'
import { useNavigate } from 'react-router-dom'
import { apiRequest } from '../api/client'
import { AgendaList } from '../components/AgendaList'
import { ErrorPanel, LoadingPanel } from '../components/StatePanels'
import type { AgendaItem, HomeData } from '../types'

const summaryMeta = {
  learning: ['学习计划', '/learning'],
  diet: ['饮食计划', '/diet'],
  games: ['游戏娱乐', '/games'],
} as const

export function HomePage() {
  const today = dayjs().format('YYYY-MM-DD')
  const [data, setData] = useState<HomeData | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
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

  async function complete(item: AgendaItem) {
    await apiRequest(`/agenda/${item.id}/complete`, { method: 'POST' })
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

  if (error) return <ErrorPanel message={error} onRetry={() => void load()} />
  if (!data) return <LoadingPanel />

  return (
    <div className="page-stack">
      <section className="welcome-row">
        <div>
          <Typography.Title level={2}>今天，专注最重要的事</Typography.Title>
          <Typography.Text type="secondary">{dayjs().format('YYYY年MM月DD日 dddd')}</Typography.Text>
        </div>
        <Progress type="circle" percent={data.stats.completion_rate} size={78} />
      </section>
      <Row gutter={16}>
        <Col span={6}><Card><Statistic title="今日事项" value={data.stats.total} /></Card></Col>
        <Col span={6}><Card><Statistic title="已经完成" value={data.stats.completed} /></Card></Col>
        <Col span={6}><Card><Statistic title="必须完成" value={data.stats.must} /></Card></Col>
        <Col span={6}><Card><Statistic title="逾期事项" value={data.stats.overdue} styles={{ content: { color: data.stats.overdue ? '#cf1322' : undefined } }} /></Card></Col>
      </Row>
      {data.stats.overdue || data.stats.due_soon ? (
        <Alert type="warning" showIcon title={`有 ${data.stats.overdue} 项逾期，${data.stats.due_soon} 项将在三天内到期`} />
      ) : null}
      <Row gutter={20} align="stretch">
        <Col span={15}>
          <Card title="今日计划" extra={<Button type="link" onClick={() => navigate('/today')}>查看全部</Button>}>
            <div className="home-plan-overviews">
              {Object.entries(summaryMeta).map(([key, [label, path]]) => {
                const summary = data.summaries[key as keyof HomeData['summaries']]
                return (
                  <button type="button" className="home-plan-overview" key={key} onClick={() => navigate(path)}>
                    <Typography.Text type="secondary">{label}</Typography.Text>
                    <Typography.Text strong>{summary.title}</Typography.Text>
                    {summary.detail ? <Typography.Text type="secondary">{summary.detail}</Typography.Text> : null}
                  </button>
                )
              })}
            </div>
            <Typography.Title level={5}>今天要完成（{data.agenda.length} 项）</Typography.Title>
            <AgendaList items={data.agenda} onComplete={(item) => void complete(item)} compact />
          </Card>
        </Col>
        <Col span={9}>
          <Card title="快速备忘">
            <Space.Compact block>
              <Input value={note} onChange={(event) => setNote(event.target.value)} onPressEnter={() => void addNote()} placeholder="随手记下一件事" />
              <Button type="primary" onClick={() => void addNote()}>记录</Button>
            </Space.Compact>
            <div className="note-list">
              {data.quick_notes.map((item) => (
                <div className="note-row" key={item.id}>
                  <Typography.Text>{item.content}</Typography.Text>
                  <Button size="small" onClick={() => void convertNote(item.id)}>加入今天</Button>
                </div>
              ))}
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  )
}
