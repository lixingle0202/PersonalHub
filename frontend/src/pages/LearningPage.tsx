import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Progress, Row, Space, Tabs, Typography, message } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { apiRequest } from '../api/client'
import { EmptyStatePanel, ErrorPanel, LoadingPanel } from '../components/StatePanels'

type LearningGoal = {
  id: string; name: string; goal: string; start_date: string | null; target_date: string | null
  estimated_minutes: number; progress: number; progress_is_manual?: boolean
  sections?: Array<{ id: string; name: string; is_completed: boolean }>
  tasks?: Array<{ id: string; title: string; plan_date: string | null; status: string | null }>
  sessions?: Array<{ id: string; studied_on: string; actual_minutes: number; notes: string; problems: string; next_step: string }>
  resources?: Array<{ id: string; name: string; link: string; notes: string }>
}

export function LearningPage() {
  const [goals, setGoals] = useState<LearningGoal[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<LearningGoal | null>(null)
  const [error, setError] = useState('')
  const [modal, setModal] = useState<'goal' | 'editGoal' | 'section' | 'task' | 'session' | 'resource' | null>(null)
  const [progressValue, setProgressValue] = useState(0)
  const [savingProgress, setSavingProgress] = useState(false)
  const [form] = Form.useForm()

  const loadGoals = useCallback(async () => {
    try { const data = await apiRequest<LearningGoal[]>('/learning/goals'); setGoals(data); setSelectedId((current) => current ?? data[0]?.id ?? null); setError('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : '读取失败') }
  }, [])
  const loadDetail = useCallback(async () => {
    if (!selectedId) { setDetail(null); return }
    setDetail(await apiRequest<LearningGoal>(`/learning/goals/${selectedId}`))
  }, [selectedId])
  useEffect(() => { void loadGoals() }, [loadGoals])
  useEffect(() => { void loadDetail() }, [loadDetail])
  useEffect(() => { if (detail) setProgressValue(detail.progress) }, [detail])

  function openCreateGoal() {
    form.resetFields()
    setModal('goal')
  }

  function openGoalEditor(goal: LearningGoal) {
    setSelectedId(goal.id)
    form.setFieldsValue({
      name: goal.name,
      goal: goal.goal,
      start_date: goal.start_date ? dayjs(goal.start_date) : null,
      target_date: goal.target_date ? dayjs(goal.target_date) : null,
      estimated_minutes: goal.estimated_minutes,
    })
    setModal('editGoal')
  }

  async function submit(values: Record<string, unknown>) {
    if (!modal) return
    const convertDate = (name: string) => values[name] instanceof Object && 'format' in (values[name] as object) ? (values[name] as Dayjs).format('YYYY-MM-DD') : values[name]
    const body = { ...values, start_date: convertDate('start_date'), target_date: convertDate('target_date'), plan_date: convertDate('plan_date'), studied_on: convertDate('studied_on') }
    if (modal === 'goal') {
      const result = await apiRequest<LearningGoal>('/learning/goals', { method: 'POST', body: JSON.stringify(body) }); await loadGoals(); setSelectedId(result.id)
    } else if (modal === 'editGoal' && selectedId) {
      const updated = await apiRequest<LearningGoal>(`/learning/goals/${selectedId}`, { method: 'PATCH', body: JSON.stringify(body) })
      setDetail(updated); await loadGoals(); message.success('学习目标已更新')
    } else if (detail) {
      const resource = modal === 'section' ? 'sections' : modal === 'task' ? 'tasks' : modal === 'session' ? 'sessions' : 'resources'
      await apiRequest(`/learning/goals/${detail.id}/${resource}`, { method: 'POST', body: JSON.stringify(body) }); await Promise.all([loadDetail(), loadGoals()])
    }
    form.resetFields(); setModal(null)
  }
  async function toggleSection(id: string, completed: boolean) {
    await apiRequest(`/learning/sections/${id}`, { method: 'PATCH', body: JSON.stringify({ is_completed: completed }) })
    await Promise.all([loadDetail(), loadGoals()])
  }
  async function saveProgress() {
    if (!detail) return
    setSavingProgress(true)
    try {
      const updated = await apiRequest<LearningGoal>(`/learning/goals/${detail.id}`, { method: 'PATCH', body: JSON.stringify({ progress: progressValue }) })
      setDetail(updated); await loadGoals(); message.success('学习进度已更新')
    } finally {
      setSavingProgress(false)
    }
  }

  if (error) return <ErrorPanel message={error} onRetry={() => void loadGoals()} />
  if (!goals) return <LoadingPanel />
  return <div className="page-stack">
    <div className="page-actions"><Typography.Text type="secondary">从长期目标拆到章节、任务和每次学习记录</Typography.Text><Button type="primary" onClick={openCreateGoal}>新建学习目标</Button></div>
    <Row gutter={20}>
      <Col span={7}><Card title="学习目标"><div className="selectable-list">{goals.map((goal) => <button aria-label={`编辑学习目标 ${goal.name}`} key={goal.id} className={goal.id === selectedId ? 'selected' : ''} onClick={() => openGoalEditor(goal)}><strong>{goal.name}</strong><span>{goal.progress}% · 点击修改</span></button>)}</div></Card></Col>
      <Col span={17}>{detail ? <Card title={detail.name} extra={<Space><Typography.Text type="secondary">{detail.progress_is_manual ? '手动进度' : '按章节计算'}</Typography.Text><InputNumber aria-label="学习进度" min={0} max={100} value={progressValue} onChange={(value) => setProgressValue(value ?? 0)} /><Typography.Text>%</Typography.Text><Button type="primary" loading={savingProgress} onClick={() => void saveProgress()}>保存进度</Button></Space>}><Typography.Paragraph>{detail.goal}</Typography.Paragraph><Typography.Text type="secondary">计划：{detail.start_date ?? '未设置'} 至 {detail.target_date ?? '未设置'} · 预计投入 {detail.estimated_minutes} 分钟</Typography.Text><Progress percent={detail.progress} /><Tabs items={[
        { key: 'route', label: '学习路线', children: <><div className="tab-actions"><Button onClick={() => setModal('section')}>添加章节</Button></div><div className="record-grid">{(detail.sections ?? []).map((item) => <Card size="small" key={item.id} className={item.is_completed ? 'record-complete' : ''}><label><input type="checkbox" checked={item.is_completed} onChange={(event) => void toggleSection(item.id, event.target.checked)} /> {item.name}</label></Card>)}</div></> },
        { key: 'tasks', label: '学习任务', children: <><div className="tab-actions"><Button onClick={() => setModal('task')}>安排学习任务</Button></div>{(detail.tasks ?? []).map((item) => <Card size="small" key={item.id}>{item.title} · {item.plan_date ?? '未排期'} · {item.status ?? '未加入计划'}</Card>)}</> },
        { key: 'sessions', label: '学习记录', children: <><div className="tab-actions"><Button onClick={() => setModal('session')}>记录一次学习</Button></div>{(detail.sessions ?? []).map((item) => <Card size="small" key={item.id}><strong>{item.studied_on} · {item.actual_minutes} 分钟</strong><p>{item.notes}</p><Typography.Text type="secondary">下一步：{item.next_step || '未填写'}</Typography.Text></Card>)}</> },
        { key: 'resources', label: '笔记与资料', children: <><div className="tab-actions"><Button onClick={() => setModal('resource')}>添加资料</Button></div>{(detail.resources ?? []).map((item) => <Card size="small" key={item.id}><a href={item.link} target="_blank" rel="noreferrer">{item.name}</a><p>{item.notes}</p></Card>)}</> },
      ]} /></Card> : <EmptyStatePanel description="选择或创建学习目标" />}</Col>
    </Row>
    <Modal forceRender title={{ goal: '新建学习目标', editGoal: '编辑学习目标', section: '添加章节', task: '安排学习任务', session: '记录学习', resource: '添加学习资料' }[modal ?? 'goal']} open={Boolean(modal)} onCancel={() => { form.resetFields(); setModal(null) }} onOk={() => form.submit()} okText={modal === 'editGoal' ? '保存修改' : '创建'}>
      <Form form={form} layout="vertical" onFinish={(values) => void submit(values)}>
        {modal === 'goal' || modal === 'editGoal' ? <><Form.Item name="name" label="学习主题" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="goal" label="学习目标"><Input.TextArea /></Form.Item><Row gutter={12}><Col span={12}><Form.Item name="start_date" label="开始日期"><DatePicker /></Form.Item></Col><Col span={12}><Form.Item name="target_date" label="计划完成"><DatePicker /></Form.Item></Col></Row><Form.Item name="estimated_minutes" label="预计投入分钟"><InputNumber min={0} /></Form.Item></> : null}
        {modal === 'section' ? <Form.Item name="name" label="章节名称" rules={[{ required: true }]}><Input /></Form.Item> : null}
        {modal === 'task' ? <><Form.Item name="title" label="学习任务" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="plan_date" label="计划日期"><DatePicker /></Form.Item></> : null}
        {modal === 'session' ? <><Form.Item name="studied_on" label="学习日期" rules={[{ required: true }]}><DatePicker /></Form.Item><Form.Item name="actual_minutes" label="实际分钟" rules={[{ required: true }]}><InputNumber min={0} /></Form.Item><Form.Item name="notes" label="学习笔记"><Input.TextArea /></Form.Item><Form.Item name="problems" label="遇到的问题"><Input.TextArea /></Form.Item><Form.Item name="next_step" label="下一步"><Input /></Form.Item></> : null}
        {modal === 'resource' ? <><Form.Item name="name" label="资料名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="link" label="链接"><Input /></Form.Item><Form.Item name="notes" label="备注"><Input.TextArea /></Form.Item></> : null}
      </Form>
    </Modal>
  </div>
}
