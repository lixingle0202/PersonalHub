import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Progress, Row, Select, Tabs, Typography } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { apiRequest } from '../api/client'
import { EntityDrawer } from '../components/EntityDrawer'
import { ErrorPanel, LoadingPanel } from '../components/StatePanels'

type Game = { id: string; name: string; platform: string; genre: string; status: string; progress: string; next_goal: string; notes: string; rating: number | null; plans?: Array<{ id: string; plan_date: string; planned_minutes: number; status: string }>; sessions?: Array<{ id: string; played_on: string; actual_minutes: number; notes: string }> }
type Budget = { period_type: string; minute_limit: number; used_minutes: number; exceeded: boolean; starts_on: string }
const statuses = [['wishlist', '想玩'], ['playing', '正在玩'], ['completed', '已通关'], ['paused', '暂时搁置']] as const

export function GamesPage() {
  const [games, setGames] = useState<Game[] | null>(null)
  const [budget, setBudget] = useState<Budget | null>(null)
  const [selected, setSelected] = useState<Game | null>(null)
  const [error, setError] = useState('')
  const [modal, setModal] = useState<'game' | 'plan' | 'session' | 'budget' | null>(null)
  const [form] = Form.useForm()
  const [editForm] = Form.useForm()

  const load = useCallback(async () => {
    try { const [gameData, budgetData] = await Promise.all([apiRequest<Game[]>('/games'), apiRequest<Budget>(`/games/budget?period_type=weekly&on=${dayjs().format('YYYY-MM-DD')}`)]); setGames(gameData); setBudget(budgetData); setError('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : '读取失败') }
  }, [])
  useEffect(() => { void load() }, [load])

  async function openGame(game: Game) { const detail = await apiRequest<Game>(`/games/${game.id}`); setSelected(detail); editForm.setFieldsValue(detail) }
  async function submit(values: Record<string, unknown>) {
    if (!modal) return
    if (modal === 'game') await apiRequest('/games', { method: 'POST', body: JSON.stringify(values) })
    else if (modal === 'budget') await apiRequest('/games/budget', { method: 'PUT', body: JSON.stringify({ ...values, period_type: 'weekly', starts_on: dayjs().startOf('week').format('YYYY-MM-DD') }) })
    else if (selected) {
      const path = modal === 'plan' ? 'plans' : 'sessions'
      const body = { ...values, plan_date: values.plan_date ? (values.plan_date as Dayjs).format('YYYY-MM-DD') : undefined, played_on: values.played_on ? (values.played_on as Dayjs).format('YYYY-MM-DD') : undefined }
      await apiRequest(`/games/${selected.id}/${path}`, { method: 'POST', body: JSON.stringify(body) })
      setSelected(await apiRequest<Game>(`/games/${selected.id}`))
    }
    form.resetFields(); setModal(null); await load()
  }
  async function saveGame() {
    if (!selected) return
    await apiRequest(`/games/${selected.id}`, { method: 'PATCH', body: JSON.stringify(await editForm.validateFields()) })
    setSelected(null); await load()
  }

  if (error) return <ErrorPanel message={error} onRetry={() => void load()} />
  if (!games || !budget) return <LoadingPanel />
  const usage = budget.minute_limit ? Math.round(budget.used_minutes * 100 / budget.minute_limit) : 0
  return <div className="page-stack">
    <div className="page-actions"><Typography.Text type="secondary">管理游戏进度，同时为娱乐时间保留边界</Typography.Text><Button type="primary" onClick={() => setModal('game')}>添加游戏</Button></div>
    {budget.exceeded ? <Alert type="warning" showIcon title={`本周已游玩 ${budget.used_minutes} 分钟，超过预算 ${budget.minute_limit} 分钟`} /> : null}
    <Card title="本周娱乐时间" extra={<Button onClick={() => setModal('budget')}>设置预算</Button>}><Progress percent={Math.min(usage, 100)} status={budget.exceeded ? 'exception' : 'active'} format={() => `${budget.used_minutes}/${budget.minute_limit || '未设置'} 分钟`} /></Card>
    <Row gutter={12} wrap={false} className="board-row">{statuses.map(([value, label]) => <Col flex="1" key={value}><section className="board-column"><div className="board-heading"><strong>{label}</strong><span>{games.filter((game) => game.status === value).length}</span></div>{games.filter((game) => game.status === value).map((game) => <Card key={game.id} size="small" hoverable onClick={() => void openGame(game)}><Typography.Text strong>{game.name}</Typography.Text><div><Typography.Text type="secondary">{game.platform || '未填平台'} · {game.progress || '暂无进度'}</Typography.Text></div></Card>)}</section></Col>)}</Row>
    <EntityDrawer title={selected?.name ?? '游戏详情'} open={Boolean(selected)} onClose={() => setSelected(null)} footer={<Button type="primary" onClick={() => void saveGame()}>保存</Button>}>
      <Form form={editForm} layout="vertical"><Form.Item name="name" label="游戏名称"><Input /></Form.Item><Row gutter={12}><Col span={12}><Form.Item name="platform" label="平台"><Input /></Form.Item></Col><Col span={12}><Form.Item name="genre" label="类型"><Input /></Form.Item></Col></Row><Form.Item name="status" label="状态"><Select options={statuses.map(([value, label]) => ({ value, label }))} /></Form.Item><Form.Item name="progress" label="当前进度"><Input /></Form.Item><Form.Item name="next_goal" label="下一步目标"><Input /></Form.Item><Form.Item name="notes" label="游玩笔记"><Input.TextArea /></Form.Item><Form.Item name="rating" label="个人评分（0-10）"><InputNumber min={0} max={10} /></Form.Item></Form>
      <Tabs items={[{ key: 'plans', label: '娱乐安排', children: <><Button onClick={() => setModal('plan')}>安排游玩</Button>{selected?.plans?.map((item) => <Card size="small" key={item.id}>{item.plan_date} · {item.planned_minutes} 分钟 · {item.status}</Card>)}</> }, { key: 'sessions', label: '游玩记录', children: <><Button onClick={() => setModal('session')}>记录游玩</Button>{selected?.sessions?.map((item) => <Card size="small" key={item.id}>{item.played_on} · {item.actual_minutes} 分钟<p>{item.notes}</p></Card>)}</> }]} />
    </EntityDrawer>
    <Modal title={modal === 'game' ? '添加游戏' : modal === 'plan' ? '安排游玩' : modal === 'session' ? '记录游玩' : '设置每周预算'} open={Boolean(modal)} onCancel={() => setModal(null)} onOk={() => form.submit()}>
      <Form form={form} layout="vertical" onFinish={(values) => void submit(values)} initialValues={{ status: 'wishlist' }}>
        {modal === 'game' ? <><Form.Item name="name" label="游戏名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="platform" label="平台"><Input /></Form.Item><Form.Item name="genre" label="类型"><Input /></Form.Item><Form.Item name="status" label="状态"><Select options={statuses.map(([value, label]) => ({ value, label }))} /></Form.Item></> : null}
        {modal === 'plan' ? <><Form.Item name="plan_date" label="日期" rules={[{ required: true }]}><DatePicker /></Form.Item><Form.Item name="planned_minutes" label="计划分钟"><InputNumber min={0} /></Form.Item></> : null}
        {modal === 'session' ? <><Form.Item name="played_on" label="日期" rules={[{ required: true }]}><DatePicker /></Form.Item><Form.Item name="actual_minutes" label="实际分钟" rules={[{ required: true }]}><InputNumber min={0} /></Form.Item><Form.Item name="notes" label="记录"><Input.TextArea /></Form.Item></> : null}
        {modal === 'budget' ? <Form.Item name="minute_limit" label="每周分钟上限" initialValue={budget.minute_limit || 300} rules={[{ required: true }]}><InputNumber min={1} /></Form.Item> : null}
      </Form>
    </Modal>
  </div>
}
