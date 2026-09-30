import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Checkbox, Col, DatePicker, Empty, Form, Input, Modal, Progress, Row, Select, Tabs, Typography } from 'antd'
import type { Dayjs } from 'dayjs'
import { apiRequest } from '../api/client'
import { ErrorPanel, LoadingPanel } from '../components/StatePanels'
import type { DevProject, DevTask } from '../types'

export function DevelopmentPage() {
  const [projects, setProjects] = useState<DevProject[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [tasks, setTasks] = useState<DevTask[]>([])
  const [error, setError] = useState('')
  const [projectOpen, setProjectOpen] = useState(false)
  const [taskOpen, setTaskOpen] = useState(false)
  const [childOpen, setChildOpen] = useState<'requirements' | 'issues' | 'milestones' | 'logs' | null>(null)
  const [children, setChildren] = useState<Record<string, Array<Record<string, unknown>>>>({ requirements: [], issues: [], milestones: [], logs: [] })
  const [projectForm] = Form.useForm()
  const [taskForm] = Form.useForm()
  const [childForm] = Form.useForm()

  const loadProjects = useCallback(async () => {
    try {
      const data = await apiRequest<DevProject[]>('/dev/projects')
      setProjects(data)
      setSelected((current) => current ?? data[0]?.id ?? null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取失败')
    }
  }, [])
  const loadTasks = useCallback(async () => {
    if (!selected) { setTasks([]); return }
    setTasks(await apiRequest<DevTask[]>(`/dev/projects/${selected}/tasks`))
  }, [selected])
  const loadChildren = useCallback(async () => {
    if (!selected) return
    const resources = ['requirements', 'issues', 'milestones', 'logs']
    const data = await Promise.all(resources.map((resource) => apiRequest<Array<Record<string, unknown>>>(`/dev/projects/${selected}/${resource}`)))
    setChildren(Object.fromEntries(resources.map((resource, index) => [resource, data[index]])))
  }, [selected])
  useEffect(() => { void loadProjects() }, [loadProjects])
  useEffect(() => { void loadTasks() }, [loadTasks])
  useEffect(() => { void loadChildren() }, [loadChildren])

  async function createProject(values: { name: string; goal?: string }) {
    const project = await apiRequest<DevProject>('/dev/projects', { method: 'POST', body: JSON.stringify({ ...values, status: 'active' }) })
    setProjectOpen(false)
    projectForm.resetFields()
    await loadProjects()
    setSelected(project.id)
  }

  async function createTask(values: { title: string; plan_date?: Dayjs; priority: string }) {
    if (!selected) return
    await apiRequest(`/dev/projects/${selected}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ ...values, plan_date: values.plan_date?.format('YYYY-MM-DD') }),
    })
    setTaskOpen(false)
    taskForm.resetFields()
    await Promise.all([loadTasks(), loadProjects()])
  }

  async function updateTask(task: DevTask, workflow_status: string) {
    await apiRequest(`/dev/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ workflow_status }) })
    await Promise.all([loadTasks(), loadProjects()])
  }

  async function createChild(values: Record<string, unknown>) {
    if (!selected || !childOpen) return
    const body = { ...values }
    for (const key of ['target_date', 'log_date']) {
      if (body[key] && typeof (body[key] as Dayjs).format === 'function') body[key] = (body[key] as Dayjs).format('YYYY-MM-DD')
    }
    await apiRequest(`/dev/projects/${selected}/${childOpen}`, { method: 'POST', body: JSON.stringify(body) })
    childForm.resetFields(); setChildOpen(null); await loadChildren()
  }

  function resourcePanel(resource: 'requirements' | 'issues' | 'milestones' | 'logs', label: string) {
    const rows = children[resource] ?? []
    return <><div className="tab-actions"><Button onClick={() => setChildOpen(resource)}>新增{label}</Button></div><div className="record-grid">{rows.map((row) => <Card size="small" key={String(row.id)}><strong>{String(row.title ?? row.name ?? row.log_date ?? label)}</strong>{resource === 'issues' ? <div><Checkbox checked={Boolean(row.is_blocking)} disabled>阻塞问题</Checkbox> · {String(row.status)}</div> : null}{resource === 'milestones' ? <div>{String(row.target_date ?? '未定日期')} · {row.is_completed ? '已完成' : '未完成'}</div> : null}{resource === 'requirements' ? <div>{String(row.priority)} · {String(row.status)}</div> : null}{resource === 'logs' ? <p>{String(row.completed_work ?? '')}</p> : null}</Card>)}</div></>
  }

  if (error) return <ErrorPanel message={error} onRetry={() => void loadProjects()} />
  if (!projects) return <LoadingPanel />
  const project = projects.find((entry) => entry.id === selected)

  return (
    <div className="page-stack">
      <div className="page-actions">
        <Typography.Text type="secondary">按项目管理功能需求、任务、问题、里程碑和开发日志</Typography.Text>
        <Button type="primary" onClick={() => setProjectOpen(true)}>新建项目</Button>
      </div>
      <Row gutter={20}>
        <Col span={7}>
          <Card title="项目">
            <div className="selectable-list">
              {projects.map((item) => <button key={item.id} className={item.id === selected ? 'selected' : ''} onClick={() => setSelected(item.id)}><strong>{item.name}</strong><span>{item.status} · {item.progress}%</span></button>)}
              {!projects.length ? <Empty description="还没有项目" /> : null}
            </div>
          </Card>
        </Col>
        <Col span={17}>
          {project ? (
            <Card title={project.name}>
              <Typography.Paragraph>{project.goal || '尚未填写项目目标'}</Typography.Paragraph>
              <Progress percent={project.progress} />
              <Tabs items={[
                { key: 'tasks', label: '开发任务', children: <><div className="tab-actions"><Button onClick={() => setTaskOpen(true)}>新增开发任务</Button></div><div className="record-list">{tasks.map((task) => <div className="record-list-row" key={task.id}><div><strong>{task.title}</strong><Typography.Text type="secondary">{task.plan_date ? `计划日期：${task.plan_date}` : '尚未排期'}</Typography.Text></div><Select aria-label={`${task.title}状态`} value={task.workflow_status} style={{ width: 110 }} onChange={(value) => void updateTask(task, value)} options={[{ value: 'todo', label: '待处理' }, { value: 'doing', label: '开发中' }, { value: 'testing', label: '测试中' }, { value: 'done', label: '已完成' }]} /></div>)}{!tasks.length ? <Empty description="还没有开发任务" /> : null}</div></> },
                { key: 'requirements', label: '功能需求', children: resourcePanel('requirements', '需求') },
                { key: 'issues', label: '问题记录', children: resourcePanel('issues', '问题') },
                { key: 'milestones', label: '里程碑', children: resourcePanel('milestones', '里程碑') },
                { key: 'logs', label: '开发日志', children: resourcePanel('logs', '日志') },
              ]} />
            </Card>
          ) : <Empty description="选择或创建一个项目" />}
        </Col>
      </Row>

      <Modal title="新建开发项目" open={projectOpen} onCancel={() => setProjectOpen(false)} onOk={() => projectForm.submit()} okText="创建">
        <Form form={projectForm} layout="vertical" onFinish={(values) => void createProject(values)}>
          <Form.Item name="name" label="项目名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="goal" label="项目目标"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>
      <Modal title="新增开发任务" open={taskOpen} onCancel={() => setTaskOpen(false)} onOk={() => taskForm.submit()} okText="创建">
        <Form form={taskForm} layout="vertical" onFinish={(values) => void createTask(values)} initialValues={{ priority: 'normal' }}>
          <Form.Item name="title" label="任务名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="plan_date" label="计划日期"><DatePicker /></Form.Item>
          <Form.Item name="priority" label="优先级"><Select options={[{ value: 'normal', label: '普通' }, { value: 'high', label: '高' }, { value: 'urgent', label: '紧急' }]} /></Form.Item>
        </Form>
      </Modal>
      <Modal title={`新增${childOpen === 'requirements' ? '需求' : childOpen === 'issues' ? '问题' : childOpen === 'milestones' ? '里程碑' : '开发日志'}`} open={Boolean(childOpen)} onCancel={() => setChildOpen(null)} onOk={() => childForm.submit()}>
        <Form form={childForm} layout="vertical" onFinish={(values) => void createChild(values)}>
          {childOpen === 'requirements' ? <><Form.Item name="title" label="需求标题" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="description" label="说明"><Input.TextArea /></Form.Item><Form.Item name="priority" label="优先级" initialValue="normal"><Select options={[{ value: 'normal', label: '普通' }, { value: 'high', label: '高' }]} /></Form.Item></> : null}
          {childOpen === 'issues' ? <><Form.Item name="title" label="问题标题" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="severity" label="严重程度" initialValue="normal"><Select options={[{ value: 'normal', label: '普通' }, { value: 'high', label: '严重' }]} /></Form.Item><Form.Item name="is_blocking" valuePropName="checked"><Checkbox>阻塞项目</Checkbox></Form.Item></> : null}
          {childOpen === 'milestones' ? <><Form.Item name="name" label="里程碑名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="target_date" label="目标日期"><DatePicker /></Form.Item></> : null}
          {childOpen === 'logs' ? <><Form.Item name="log_date" label="日期" rules={[{ required: true }]}><DatePicker /></Form.Item><Form.Item name="completed_work" label="完成内容"><Input.TextArea /></Form.Item><Form.Item name="problems" label="遇到问题"><Input.TextArea /></Form.Item><Form.Item name="decisions" label="重要决定"><Input.TextArea /></Form.Item></> : null}
        </Form>
      </Modal>
    </div>
  )
}
