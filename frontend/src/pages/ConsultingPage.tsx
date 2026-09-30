import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Col, DatePicker, Form, Input, Modal, Row, Select, Space, Steps, Tabs, Timeline, Typography, message } from 'antd'
import type { Dayjs } from 'dayjs'
import { apiRequest } from '../api/client'
import { EmptyStatePanel, ErrorPanel, LoadingPanel } from '../components/StatePanels'

type Consultation = {
  id: string; title: string; client_name: string; contact: string; original_question: string
  stage: string; background: string; goal: string; current_state: string; constraints: string
  overall_advice: string; resources: string; notes: string; next_followup_date: string | null
  plan_stages?: Array<{ id: string; title: string; goal: string; steps: string; schedule: string }>
  communications?: Array<{ id: string; communicated_at: string; content: string; feedback: string; changes: string }>
  followups?: Array<{ id: string; title: string; plan_date: string; status: string }>
}

const stageOptions = [
  { value: 'intake', label: '待了解' }, { value: 'analyzing', label: '分析中' },
  { value: 'drafting', label: '方案编写中' }, { value: 'feedback', label: '待反馈' },
  { value: 'completed', label: '已完成' },
]

export function ConsultingPage() {
  const [items, setItems] = useState<Consultation[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Consultation | null>(null)
  const [error, setError] = useState('')
  const [modal, setModal] = useState<'create' | 'stage' | 'communication' | 'followup' | null>(null)
  const [createForm] = Form.useForm()
  const [detailForm] = Form.useForm()
  const [childForm] = Form.useForm()

  const loadList = useCallback(async () => {
    try {
      const data = await apiRequest<Consultation[]>('/consultations')
      setItems(data); setSelectedId((current) => current ?? data[0]?.id ?? null); setError('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '读取失败') }
  }, [])
  const loadDetail = useCallback(async () => {
    if (!selectedId) { setDetail(null); return }
    const data = await apiRequest<Consultation>(`/consultations/${selectedId}`)
    setDetail(data)
  }, [selectedId])
  useEffect(() => { void loadList() }, [loadList])
  useEffect(() => { void loadDetail() }, [loadDetail])
  useEffect(() => { if (detail) detailForm.setFieldsValue(detail) }, [detail, detailForm])

  async function create(values: Record<string, string>) {
    const result = await apiRequest<Consultation>('/consultations', { method: 'POST', body: JSON.stringify(values) })
    setModal(null); createForm.resetFields(); await loadList(); setSelectedId(result.id)
  }
  async function saveDetail() {
    if (!detail) return
    await apiRequest(`/consultations/${detail.id}`, { method: 'PATCH', body: JSON.stringify(await detailForm.validateFields()) })
    message.success('咨询内容已保存'); await Promise.all([loadDetail(), loadList()])
  }
  async function addChild() {
    if (!detail || !modal || modal === 'create') return
    const values = await childForm.validateFields()
    const resource = modal === 'stage' ? 'stages' : modal === 'communication' ? 'communications' : 'followups'
    const body = modal === 'followup' ? { ...values, plan_date: (values.plan_date as Dayjs).format('YYYY-MM-DD') } : values
    await apiRequest(`/consultations/${detail.id}/${resource}`, { method: 'POST', body: JSON.stringify(body) })
    childForm.resetFields(); setModal(null); await Promise.all([loadDetail(), loadList()])
  }
  async function copyPlan() {
    if (!detail) return
    const result = await apiRequest<{ text: string }>(`/consultations/${detail.id}/copy-text`)
    await navigator.clipboard.writeText(result.text)
    message.success('完整方案已复制')
  }

  if (error) return <ErrorPanel message={error} onRetry={() => void loadList()} />
  if (!items) return <LoadingPanel />
  return (
    <div className="page-stack">
      <div className="page-actions"><Typography.Text type="secondary">按咨询案例整理需求、方案、沟通与跟进</Typography.Text><Button type="primary" onClick={() => setModal('create')}>新建咨询</Button></div>
      <Row gutter={20}>
        <Col span={7}>
          <Card title="咨询案例">
            <div className="selectable-list">
              {items.map((item) => <button key={item.id} className={item.id === selectedId ? 'selected' : ''} onClick={() => setSelectedId(item.id)}><strong>{item.title}</strong><span>{stageOptions.find((stage) => stage.value === item.stage)?.label}{item.next_followup_date ? ` · ${item.next_followup_date}` : ''}</span></button>)}
              {!items.length ? <EmptyStatePanel description="还没有咨询案例" actionLabel="新建咨询" onAction={() => setModal('create')} /> : null}
            </div>
          </Card>
        </Col>
        <Col span={17}>
          {detail ? <Card title={detail.title} extra={<Space><Button onClick={() => void copyPlan()}>复制完整方案</Button><Button type="primary" onClick={() => void saveDetail()}>保存</Button></Space>}>
            <Tabs items={[
              { key: 'needs', label: '需求整理', children: <Form form={detailForm} layout="vertical"><Row gutter={12}><Col span={12}><Form.Item name="client_name" label="咨询人"><Input /></Form.Item></Col><Col span={12}><Form.Item name="contact" label="联系方式"><Input /></Form.Item></Col></Row><Form.Item name="stage" label="处理阶段"><Select options={stageOptions} /></Form.Item><Form.Item name="original_question" label="原始问题"><Input.TextArea rows={3} /></Form.Item><Form.Item name="background" label="背景"><Input.TextArea rows={3} /></Form.Item><Form.Item name="goal" label="目标"><Input.TextArea rows={2} /></Form.Item><Form.Item name="current_state" label="当前情况"><Input.TextArea rows={2} /></Form.Item><Form.Item name="constraints" label="限制条件"><Input.TextArea rows={2} /></Form.Item><Form.Item name="overall_advice" label="总体建议"><Input.TextArea rows={4} /></Form.Item><Form.Item name="resources" label="推荐资料"><Input.TextArea rows={3} /></Form.Item></Form> },
              { key: 'plan', label: '分阶段方案', children: <><div className="tab-actions"><Button onClick={() => setModal('stage')}>添加阶段</Button></div><Steps orientation="vertical" items={(detail.plan_stages ?? []).map((item) => ({ title: item.title, description: <><p>{item.goal}</p><p>{item.steps}</p><Typography.Text type="secondary">{item.schedule}</Typography.Text></> }))} /></> },
              { key: 'communication', label: '沟通记录', children: <><div className="tab-actions"><Button onClick={() => setModal('communication')}>记录沟通</Button></div><Timeline items={(detail.communications ?? []).map((item) => ({ children: <><strong>{new Date(item.communicated_at).toLocaleString()}</strong><p>{item.content}</p><p>{item.feedback}</p></> }))} /></> },
              { key: 'followup', label: '跟进', children: <><div className="tab-actions"><Button onClick={() => setModal('followup')}>安排跟进</Button></div>{(detail.followups ?? []).map((item) => <Card size="small" key={item.id}>{item.title} · {item.plan_date} · {item.status}</Card>)}</> },
            ]} />
          </Card> : <EmptyStatePanel description="请选择一个咨询案例" />}
        </Col>
      </Row>
      <Modal title="新建咨询" open={modal === 'create'} onCancel={() => setModal(null)} onOk={() => createForm.submit()} okText="创建">
        <Form form={createForm} layout="vertical" onFinish={(values) => void create(values)} initialValues={{ stage: 'intake' }}><Form.Item name="title" label="咨询标题" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="client_name" label="咨询人"><Input /></Form.Item><Form.Item name="original_question" label="原始问题"><Input.TextArea rows={4} /></Form.Item><Form.Item name="stage" label="阶段"><Select options={stageOptions} /></Form.Item></Form>
      </Modal>
      <Modal title={modal === 'stage' ? '添加方案阶段' : modal === 'communication' ? '记录沟通' : '安排跟进'} open={Boolean(modal && modal !== 'create')} onCancel={() => setModal(null)} onOk={() => void addChild()}>
        <Form form={childForm} layout="vertical">
          {modal === 'stage' ? <><Form.Item name="title" label="阶段名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="goal" label="阶段目标"><Input.TextArea /></Form.Item><Form.Item name="steps" label="具体步骤"><Input.TextArea rows={4} /></Form.Item><Form.Item name="schedule" label="时间安排"><Input /></Form.Item></> : null}
          {modal === 'communication' ? <><Form.Item name="content" label="沟通内容"><Input.TextArea rows={3} /></Form.Item><Form.Item name="feedback" label="对方反馈"><Input.TextArea /></Form.Item><Form.Item name="changes" label="方案修改"><Input.TextArea /></Form.Item></> : null}
          {modal === 'followup' ? <><Form.Item name="title" label="跟进事项" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="plan_date" label="跟进日期" rules={[{ required: true }]}><DatePicker /></Form.Item></> : null}
        </Form>
      </Modal>
    </div>
  )
}
