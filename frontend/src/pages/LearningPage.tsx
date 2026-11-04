import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Progress, Row, Space, Tabs, Typography, message } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { apiRequest } from '../api/client'
import { AILearningGenerator } from '../components/AILearningGenerator'
import { ConfirmDangerButton } from '../components/ConfirmDangerButton'
import { FocusTimer } from '../components/FocusTimer'
import { EmptyStatePanel, ErrorPanel, LoadingPanel } from '../components/StatePanels'

type LearningTask = { id: string; title: string; details?: string; estimated_minutes?: number | null; plan_date: string | null; status: string | null; section_id?: string | null; agenda_id?: string | null }
type LearningSection = { id: string; name: string; is_completed: boolean }
type Editor = 'goal' | 'editGoal' | 'section' | 'editSection' | 'task' | 'editTask' | 'session' | 'resource'
type LearningGoal = {
  id: string; name: string; goal: string; start_date: string | null; target_date: string | null
  estimated_minutes: number; progress: number; progress_is_manual?: boolean
  sections?: LearningSection[]
  tasks?: LearningTask[]
  sessions?: Array<{ id: string; studied_on: string; actual_minutes: number; notes: string; problems: string; next_step: string }>
  resources?: Array<{ id: string; name: string; link: string; notes: string }>
}

function dailyTaskGroups(goal: LearningGoal): Array<[string, LearningTask[]]> {
  const groups = new Map<string, LearningTask[]>()
  for (const task of goal.tasks ?? []) {
    const date = task.plan_date ?? '未排期'
    groups.set(date, [...(groups.get(date) ?? []), task])
  }

  const datedTasks = [...groups.keys()].filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort()
  const start = goal.start_date && dayjs(goal.start_date).isValid() ? dayjs(goal.start_date) : null
  const end = goal.target_date && dayjs(goal.target_date).isValid() ? dayjs(goal.target_date) : null
  const plannedSpan = start && end ? end.diff(start, 'day') : -1
  const first = plannedSpan >= 0 && plannedSpan <= 366 ? start : datedTasks.length ? dayjs(datedTasks[0]) : null
  const last = plannedSpan >= 0 && plannedSpan <= 366 ? end : datedTasks.length ? dayjs(datedTasks[datedTasks.length - 1]) : null
  if (first && last && last.diff(first, 'day') <= 366) {
    for (let date = first; !date.isAfter(last, 'day'); date = date.add(1, 'day')) {
      const key = date.format('YYYY-MM-DD')
      if (!groups.has(key)) groups.set(key, [])
    }
  }
  return [...groups].sort(([left], [right]) => left === '未排期' ? 1 : right === '未排期' ? -1 : left.localeCompare(right))
}

export function LearningPage() {
  const [goals, setGoals] = useState<LearningGoal[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<LearningGoal | null>(null)
  const [error, setError] = useState('')
  const [modal, setModal] = useState<Editor | null>(null)
  const [editingGoal, setEditingGoal] = useState<LearningGoal | null>(null)
  const [editingTask, setEditingTask] = useState<LearningTask | null>(null)
  const [editingSection, setEditingSection] = useState<LearningSection | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [progressValue, setProgressValue] = useState(0)
  const [savingProgress, setSavingProgress] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [togglingTaskId, setTogglingTaskId] = useState<string | null>(null)
  const [form] = Form.useForm()
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId
  const detailVersion = useRef(0)
  const goalsVersion = useRef(0)
  const mutationLock = useRef(false)
  const editorBusy = saving || deleting

  const loadGoals = useCallback(async () => {
    const version = ++goalsVersion.current
    try {
      const data = await apiRequest<LearningGoal[]>('/learning/goals')
      if (version !== goalsVersion.current) return
      setGoals(data)
      setSelectedId((current) => data.some((goal) => goal.id === current) ? current : data[0]?.id ?? null)
      setError('')
    } catch (reason) { if (version === goalsVersion.current) setError(reason instanceof Error ? reason.message : '读取失败') }
  }, [])
  const loadDetail = useCallback(async () => {
    const version = ++detailVersion.current
    setDetailError('')
    if (!selectedId) { setDetail(null); return }
    try {
      const data = await apiRequest<LearningGoal>(`/learning/goals/${selectedId}`)
      if (version === detailVersion.current && selectedRef.current === selectedId) setDetail(data)
    } catch (reason) {
      if (version === detailVersion.current && selectedRef.current === selectedId) {
        setDetail(null)
        setDetailError(reason instanceof Error ? reason.message : '读取失败')
      }
    }
  }, [selectedId])
  useEffect(() => { void loadGoals(); return () => { ++goalsVersion.current } }, [loadGoals])
  useEffect(() => { void loadDetail(); return () => { ++detailVersion.current } }, [loadDetail])
  useEffect(() => { if (detail) setProgressValue(detail.progress) }, [detail])

  function openCreateGoal() {
    form.resetFields()
    setEditingGoal(null); setEditingTask(null); setSaveError('')
    setModal('goal')
  }

  function openGoalEditor(goal: LearningGoal) {
    form.resetFields()
    setSelectedId(goal.id)
    selectedRef.current = goal.id
    setEditingGoal(goal); setEditingTask(null); setSaveError('')
    form.setFieldsValue({
      name: goal.name,
      goal: goal.goal,
      start_date: goal.start_date ? dayjs(goal.start_date) : null,
      target_date: goal.target_date ? dayjs(goal.target_date) : null,
      estimated_minutes: goal.estimated_minutes,
    })
    setModal('editGoal')
  }

  function openTaskEditor(task: LearningTask) {
    if (!detail || detail.id !== selectedId) return
    form.resetFields()
    setEditingGoal(detail); setEditingTask(task); setSaveError('')
    form.setFieldsValue({ title: task.title, details: task.details ?? '', section_id: task.section_id ?? '', estimated_minutes: task.estimated_minutes ?? null, plan_date: task.plan_date ? dayjs(task.plan_date) : null })
    setModal('editTask')
  }

  function openSectionEditor(section: LearningSection) {
    if (!detail || detail.id !== selectedId) return
    form.resetFields()
    setEditingGoal(detail); setEditingTask(null); setEditingSection(section); setSaveError('')
    form.setFieldsValue({ name: section.name })
    setModal('editSection')
  }

  function openChildEditor(next: 'section' | 'task' | 'session' | 'resource', planDate?: string) {
    if (!detail || detail.id !== selectedId) return
    form.resetFields()
    setEditingGoal(detail); setEditingTask(null); setEditingSection(null); setSaveError('')
    if (next === 'task' && planDate) form.setFieldsValue({ plan_date: dayjs(planDate) })
    setModal(next)
  }

  function closeEditor() {
    form.resetFields()
    setModal(null); setEditingGoal(null); setEditingTask(null); setEditingSection(null)
    setSaveError(''); setDeleteConfirmOpen(false); setDeleteError('')
  }

  async function submit(values: Record<string, unknown>) {
    if (!modal || mutationLock.current) return
    mutationLock.current = true
    setSaving(true); setSaveError('')
    const convertDate = (name: string) => dayjs.isDayjs(values[name]) ? (values[name] as Dayjs).format('YYYY-MM-DD') : values[name]
    const body: Record<string, unknown> = { ...values, start_date: convertDate('start_date'), target_date: convertDate('target_date'), plan_date: convertDate('plan_date'), studied_on: convertDate('studied_on') }
    if (modal === 'goal' || modal === 'editGoal') body.estimated_minutes = values.estimated_minutes ?? 0
    if (modal === 'task') body.section_id = values.section_id || null
    try {
      if (modal === 'goal') {
        const result = await apiRequest<LearningGoal>('/learning/goals', { method: 'POST', body: JSON.stringify(body) })
        await loadGoals(); selectedRef.current = result.id; setSelectedId(result.id)
      } else if (modal === 'editGoal' && editingGoal) {
        const updated = await apiRequest<LearningGoal>(`/learning/goals/${editingGoal.id}`, { method: 'PATCH', body: JSON.stringify(body) })
        ++detailVersion.current
        if (selectedRef.current === updated.id) setDetail(updated)
        await loadGoals(); message.success('学习目标已更新')
      } else if (modal === 'editTask' && editingTask) {
        await apiRequest(`/learning/tasks/${editingTask.id}`, { method: 'PATCH', body: JSON.stringify({ title: values.title, details: values.details ?? '', section_id: values.section_id || null, estimated_minutes: values.estimated_minutes ?? null, plan_date: convertDate('plan_date') ?? null }) })
        await Promise.all([loadDetail(), loadGoals()]); message.success('学习任务已更新')
      } else if (modal === 'editSection' && editingSection) {
        await apiRequest(`/learning/sections/${editingSection.id}`, { method: 'PATCH', body: JSON.stringify({ name: values.name }) })
        await Promise.all([loadDetail(), loadGoals()]); message.success('学习章节已更新')
      } else if (editingGoal) {
        const resource = modal === 'section' ? 'sections' : modal === 'task' ? 'tasks' : modal === 'session' ? 'sessions' : 'resources'
        await apiRequest(`/learning/goals/${editingGoal.id}/${resource}`, { method: 'POST', body: JSON.stringify(body) })
        await Promise.all([loadDetail(), loadGoals()])
      }
      closeEditor()
    } catch (reason) { setSaveError(reason instanceof Error ? reason.message : '保存失败，请重试') }
    finally { mutationLock.current = false; setSaving(false) }
  }

  async function deleteCurrentPlan() {
    if (!editingGoal || mutationLock.current) return
    mutationLock.current = true
    setDeleting(true); setDeleteError('')
    try {
      if (editingTask) {
        const taskId = editingTask.id
        await apiRequest(`/learning/tasks/${taskId}`, { method: 'DELETE' })
        ++detailVersion.current
        setDetail((current) => current ? { ...current, tasks: current.tasks?.filter((task) => task.id !== taskId) } : current)
        closeEditor()
        await Promise.all([loadDetail(), loadGoals()])
        message.success('学习任务已删除，其他模块已同步移除')
      } else if (editingSection) {
        await apiRequest(`/learning/sections/${editingSection.id}`, { method: 'DELETE' })
        closeEditor()
        await Promise.all([loadDetail(), loadGoals()])
        message.success('学习章节已删除，原有任务仍可单独修改或删除')
      } else {
        const goalId = editingGoal.id
        await apiRequest(`/learning/goals/${goalId}`, { method: 'DELETE' })
        ++detailVersion.current
        const remaining = (goals ?? []).filter((goal) => goal.id !== goalId)
        const nextId = remaining[0]?.id ?? null
        setGoals(remaining); setDetail(null); setDetailError('')
        selectedRef.current = nextId; setSelectedId(nextId)
        closeEditor()
        await loadGoals()
        message.success('学习计划已删除，关联任务已同步移除')
      }
    } catch (reason) { setDeleteError(reason instanceof Error ? reason.message : '删除失败，请重试') }
    finally { mutationLock.current = false; setDeleting(false) }
  }
  async function toggleSection(id: string, completed: boolean) {
    try {
      await apiRequest(`/learning/sections/${id}`, { method: 'PATCH', body: JSON.stringify({ is_completed: completed }) })
      await Promise.all([loadDetail(), loadGoals()])
    } catch (reason) { message.error(reason instanceof Error ? reason.message : '更新学习阶段失败') }
  }
  async function toggleTask(task: LearningTask) {
    if (!task.agenda_id || !task.plan_date || togglingTaskId) return
    setTogglingTaskId(task.id)
    try {
      const completed = task.status === 'completed'
      await apiRequest(`/agenda/${task.agenda_id}/${completed ? 'reschedule' : 'complete'}`, {
        method: 'POST', body: JSON.stringify(completed ? { plan_date: task.plan_date } : {}),
      })
      await Promise.all([loadDetail(), loadGoals()])
    } catch (reason) { message.error(reason instanceof Error ? reason.message : '更新任务完成状态失败') }
    finally { setTogglingTaskId(null) }
  }
  async function saveProgress() {
    if (!detail) return
    const goalId = detail.id
    setSavingProgress(true)
    try {
      const updated = await apiRequest<LearningGoal>(`/learning/goals/${goalId}`, { method: 'PATCH', body: JSON.stringify({ progress: progressValue }) })
      if (selectedRef.current === goalId) { ++detailVersion.current; setDetail(updated) }
      await loadGoals(); message.success('学习进度已更新')
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '保存失败，请重试')
    } finally {
      setSavingProgress(false)
    }
  }
  async function resetAllPlans() {
    setResetting(true)
    try {
      await apiRequest('/learning/reset', { method: 'POST' })
      setSelectedId(null)
      setDetail(null)
      await loadGoals()
      message.success('全部学习计划已清零')
    } finally {
      setResetting(false)
    }
  }

  const taskGroups = detail ? dailyTaskGroups(detail) : []
  const linkedSectionIds = new Set(detail?.tasks?.map((task) => task.section_id).filter(Boolean))
  const unassignedSections = detail?.sections?.filter((section) => !linkedSectionIds.has(section.id)) ?? []
  const planTab = detail ? <>
    <div className="tab-actions"><Space><Button onClick={() => openChildEditor('section')}>添加章节</Button><Button onClick={() => openChildEditor('task')}>安排学习任务</Button></Space></div>
    <Typography.Title level={5}>每日学习任务</Typography.Title>
    {taskGroups.length ? taskGroups.map(([date, tasks]) => <section className="learning-day" key={date}>
      <div className="learning-day-header"><Typography.Title level={5}>{date}</Typography.Title>{date !== '未排期' ? <Button type="text" className="learning-day-add" aria-label={`添加 ${date} 学习任务`} onClick={() => openChildEditor('task', date)}>＋</Button> : null}</div>
      {tasks.length ? <div className="learning-task-list">{tasks.map((item) => {
        const section = detail.sections?.find((candidate) => candidate.id === item.section_id)
        return <div className={`learning-task ${item.status === 'completed' ? 'record-complete' : ''}`} key={item.id}>
          <input type="checkbox" aria-label={`完成学习任务 ${item.title}`} checked={item.status === 'completed'} disabled={!item.agenda_id || Boolean(togglingTaskId)} onChange={() => void toggleTask(item)} />
          <div className="learning-task-content"><strong>{item.title}</strong>{item.details ? <span className="learning-task-details">{item.details}</span> : null}
            {section ? <div className="learning-task-stage"><span>学习阶段：</span><Button type="link" size="small" aria-label={`修改学习章节 ${section.name}`} onClick={() => openSectionEditor(section)}>{section.name}</Button><label><input type="checkbox" aria-label={`完成阶段 ${section.name}`} checked={section.is_completed} onChange={(event) => void toggleSection(section.id, event.target.checked)} /> 阶段完成</label></div> : null}
            <span>{item.estimated_minutes ? `预计 ${item.estimated_minutes} 分钟 · ` : ''}{item.status === 'completed' ? '已完成' : item.agenda_id ? '待完成' : '先设置日期后可勾选'}</span>
          </div><Button aria-label={`编辑学习任务 ${item.title}`} onClick={() => openTaskEditor(item)}>修改或删除</Button>
        </div>
      })}</div> : <Typography.Text type="secondary" className="learning-day-empty">当天暂无任务，点击日期旁的 ＋ 添加。</Typography.Text>}
    </section>) : <Typography.Text type="secondary">还没有学习任务，点击“安排学习任务”添加。</Typography.Text>}
    {unassignedSections.length ? <div className="learning-unassigned-sections"><Typography.Text type="secondary">尚未安排任务的阶段：</Typography.Text>{unassignedSections.map((section) => <Space key={section.id}><Button size="small" aria-label={`修改学习章节 ${section.name}`} onClick={() => openSectionEditor(section)}>{section.name}</Button><label><input type="checkbox" aria-label={`完成阶段 ${section.name}`} checked={section.is_completed} onChange={(event) => void toggleSection(section.id, event.target.checked)} /> 阶段完成</label></Space>)}</div> : null}
  </> : null

  if (error) return <ErrorPanel message={error} onRetry={() => void loadGoals()} />
  if (!goals) return <LoadingPanel />
  return <div className="page-stack">
    <div className="page-actions"><Typography.Text type="secondary">从长期目标拆到章节和任务</Typography.Text><Space><AILearningGenerator initialTopic={detail?.name} initialObjective={detail?.goal} onImported={async (id) => { await loadGoals(); setSelectedId(id); if (id === selectedId) await loadDetail() }} /><ConfirmDangerButton label="清零全部学习计划" title="确认清零全部学习计划？" description="所有学习目标、任务和记录都会取消并从页面隐藏，可在回收站中恢复。" disabled={resetting || goals.length === 0} onConfirm={resetAllPlans} /><Button type="primary" onClick={openCreateGoal}>新建学习目标</Button></Space></div>
    <Row gutter={20}>
      <Col span={7}><Card title="学习目标"><div className="selectable-list">{goals.map((goal) => <button type="button" aria-label={`编辑学习目标 ${goal.name}`} disabled={editorBusy || savingProgress} key={goal.id} className={goal.id === selectedId ? 'selected' : ''} onClick={() => openGoalEditor(goal)}><strong>{goal.name}</strong><span>{goal.progress}% · 点击修改</span></button>)}</div></Card></Col>
      <Col span={17}>{detailError ? <ErrorPanel message={detailError} onRetry={() => void loadDetail()} /> : selectedId && detail?.id !== selectedId ? <LoadingPanel /> : detail ? <Card title={detail.name} extra={<Space><Typography.Text type="secondary">{detail.progress_is_manual ? '手动进度' : '按章节计算'}</Typography.Text><InputNumber aria-label="学习进度" min={0} max={100} value={progressValue} onChange={(value) => setProgressValue(value ?? 0)} /><Typography.Text>%</Typography.Text><Button type="primary" loading={savingProgress} onClick={() => void saveProgress()}>保存进度</Button></Space>}><Typography.Paragraph>{detail.goal}</Typography.Paragraph><Typography.Text type="secondary">计划：{detail.start_date ?? '未设置'} 至 {detail.target_date ?? '未设置'} · 预计投入 {detail.estimated_minutes} 分钟</Typography.Text><Progress percent={detail.progress} /><FocusTimer goalId={detail.id} tasks={detail.tasks ?? []} /><Tabs items={[
        { key: 'plan', label: '学习计划', children: planTab },
        { key: 'sessions', label: '学习记录', children: <><div className="tab-actions"><Button onClick={() => openChildEditor('session')}>记录一次学习</Button></div>{(detail.sessions ?? []).map((item) => <Card size="small" key={item.id}><strong>{item.studied_on} · {item.actual_minutes} 分钟</strong><p>{item.notes}</p><Typography.Text type="secondary">下一步：{item.next_step || '未填写'}</Typography.Text></Card>)}</> },
        { key: 'resources', label: '笔记与资料', children: <><div className="tab-actions"><Button onClick={() => openChildEditor('resource')}>添加资料</Button></div>{(detail.resources ?? []).map((item) => <Card size="small" key={item.id}><a href={item.link} target="_blank" rel="noreferrer">{item.name}</a><p>{item.notes}</p></Card>)}</> },
      ]} /></Card> : <EmptyStatePanel description="选择或创建学习目标" />}</Col>
    </Row>
    <Modal forceRender title={{ goal: '新建学习目标', editGoal: '编辑学习目标', section: '添加章节', editSection: '编辑学习章节', task: '安排学习任务', editTask: '编辑学习任务', session: '记录学习', resource: '添加学习资料' }[modal ?? 'goal']} open={Boolean(modal)} closable={{ disabled: editorBusy }} keyboard={!editorBusy} mask={{ closable: !editorBusy }} onCancel={() => { if (!editorBusy) closeEditor() }} footer={
      <div className="editor-footer"><div>{modal === 'editGoal' || modal === 'editTask' || modal === 'editSection' ? <Button danger aria-label={modal === 'editTask' ? '删除此任务' : modal === 'editSection' ? '删除此章节' : '删除此计划'} disabled={editorBusy} onClick={() => { setDeleteError(''); setDeleteConfirmOpen(true) }}>{modal === 'editTask' ? '删除此任务' : modal === 'editSection' ? '删除此章节' : '删除此计划'}</Button> : null}</div><Space><Button aria-label="取消" disabled={editorBusy} onClick={closeEditor}>取消</Button><Button type="primary" aria-label={modal === 'editGoal' || modal === 'editTask' || modal === 'editSection' ? '保存修改' : '创建'} loading={saving} disabled={deleting} onClick={() => form.submit()}>{modal === 'editGoal' || modal === 'editTask' || modal === 'editSection' ? '保存修改' : '创建'}</Button></Space></div>
    }>
      {saveError ? <Alert type="error" showIcon title={saveError} /> : null}
      <Form form={form} layout="vertical" onFinish={(values) => void submit(values)}>
        {modal === 'goal' || modal === 'editGoal' ? <><Form.Item name="name" label="学习主题" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="goal" label="学习目标"><Input.TextArea /></Form.Item><Row gutter={12}><Col span={12}><Form.Item name="start_date" label="开始日期"><DatePicker /></Form.Item></Col><Col span={12}><Form.Item name="target_date" label="计划完成"><DatePicker /></Form.Item></Col></Row><Form.Item name="estimated_minutes" label="预计投入分钟"><InputNumber min={0} /></Form.Item></> : null}
        {modal === 'section' || modal === 'editSection' ? <Form.Item name="name" label="章节名称" rules={[{ required: true }]}><Input /></Form.Item> : null}
        {modal === 'task' || modal === 'editTask' ? <><Form.Item name="title" label="学习任务" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="details" label="任务详情"><Input.TextArea rows={4} placeholder="具体内容、练习步骤或完成标准" /></Form.Item><Form.Item name="section_id" label="所属阶段"><select className="native-form-select"><option value="">未分类</option>{detail?.sections?.map((section) => <option value={section.id} key={section.id}>{section.name}</option>)}</select></Form.Item><Form.Item name="estimated_minutes" label="预计分钟"><InputNumber min={1} max={1440} /></Form.Item><Form.Item name="plan_date" label="计划日期"><DatePicker /></Form.Item></> : null}
        {modal === 'session' ? <><Form.Item name="studied_on" label="学习日期" rules={[{ required: true }]}><DatePicker /></Form.Item><Form.Item name="actual_minutes" label="实际分钟" rules={[{ required: true }]}><InputNumber min={0} /></Form.Item><Form.Item name="notes" label="学习笔记"><Input.TextArea /></Form.Item><Form.Item name="problems" label="遇到的问题"><Input.TextArea /></Form.Item><Form.Item name="next_step" label="下一步"><Input /></Form.Item></> : null}
        {modal === 'resource' ? <><Form.Item name="name" label="资料名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="link" label="链接"><Input /></Form.Item><Form.Item name="notes" label="备注"><Input.TextArea /></Form.Item></> : null}
      </Form>
    </Modal>
    <Modal title={editingTask ? '确认删除此学习任务？' : editingSection ? '确认删除此学习章节？' : '确认删除此学习计划？'} centered width={440} open={deleteConfirmOpen} onOk={() => void deleteCurrentPlan()} onCancel={() => { if (!deleting) { setDeleteConfirmOpen(false); setDeleteError('') } }} okText="确认" cancelText="取消" confirmLoading={deleting} okButtonProps={{ danger: true, disabled: editorBusy, 'aria-label': '确认删除' }} cancelButtonProps={{ disabled: deleting, 'aria-label': '取消删除' }} closable={!deleting} keyboard={!deleting} mask={{ closable: !deleting }}>
      <Typography.Paragraph><Typography.Text strong>{editingTask?.title ?? editingSection?.name ?? editingGoal?.name}</Typography.Text></Typography.Paragraph>
      <Typography.Paragraph>{editingTask ? '此任务将从学习计划、首页、今日计划和搜索中移除，所属目标和其他任务保留。' : editingSection ? '此阶段将从学习计划移除；关联的学习任务仍会保留，可单独修改或删除。' : '此计划及其章节、任务、学习记录和资料将移至回收站，首页、今日计划和搜索也会同步移除关联任务。'}</Typography.Paragraph>
      {deleteError ? <Alert type="error" showIcon title={deleteError} /> : null}
    </Modal>
  </div>
}
