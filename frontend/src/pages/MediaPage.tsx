import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Row, Select, Space, Typography, message } from 'antd'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import { apiRequest } from '../api/client'
import { EntityDrawer } from '../components/EntityDrawer'
import { ErrorPanel, LoadingPanel } from '../components/StatePanels'

type MediaItem = {
  id: string; title: string; platform: string; content_type: string; stage: string
  outline: string; body: string; reference_links: string; publish_link: string
  target_date: string | null; published_at: string | null; notes: string
}

const stages = [
  ['idea', '灵感'], ['preparing', '准备中'], ['creating', '创作中'], ['ready', '待发布'], ['published', '已发布'],
] as const

export function MediaPage() {
  const [items, setItems] = useState<MediaItem[] | null>(null)
  const [error, setError] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [selected, setSelected] = useState<MediaItem | null>(null)
  const [metricOpen, setMetricOpen] = useState(false)
  const [createForm] = Form.useForm()
  const [editForm] = Form.useForm()
  const [metricForm] = Form.useForm()

  const load = useCallback(async () => {
    try { setItems(await apiRequest<MediaItem[]>('/media')); setError('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : '读取失败') }
  }, [])
  useEffect(() => { void load() }, [load])

  async function create(values: { title: string; platform?: string; content_type?: string; target_date?: Dayjs }) {
    await apiRequest('/media', { method: 'POST', body: JSON.stringify({ ...values, target_date: values.target_date?.format('YYYY-MM-DD') }) })
    setCreateOpen(false); createForm.resetFields(); await load()
  }

  async function transition(item: MediaItem, stage: string) {
    await apiRequest(`/media/${item.id}/transition`, { method: 'POST', body: JSON.stringify({ stage }) })
    await load()
  }

  function openDetail(item: MediaItem) {
    setSelected(item)
    editForm.setFieldsValue({ ...item, target_date: item.target_date ? dayjs(item.target_date) : null })
  }

  async function saveDetail() {
    if (!selected) return
    const values = await editForm.validateFields()
    await apiRequest(`/media/${selected.id}`, {
      method: 'PATCH', body: JSON.stringify({ ...values, target_date: values.target_date?.format('YYYY-MM-DD') }),
    })
    message.success('内容已保存'); setSelected(null); await load()
  }

  async function addMetric() {
    if (!selected) return
    const values = await metricForm.validateFields()
    await apiRequest(`/media/${selected.id}/metrics`, {
      method: 'POST', body: JSON.stringify({ ...values, recorded_on: values.recorded_on.format('YYYY-MM-DD') }),
    })
    metricForm.resetFields(); setMetricOpen(false); message.success('表现数据已记录')
  }

  if (error) return <ErrorPanel message={error} onRetry={() => void load()} />
  if (!items) return <LoadingPanel />
  return (
    <div className="page-stack">
      <div className="page-actions">
        <Typography.Text type="secondary">从灵感到发布，拖动卡片推进内容流程</Typography.Text>
        <Button type="primary" onClick={() => setCreateOpen(true)}>记录内容灵感</Button>
      </div>
      <Row gutter={12} wrap={false} className="board-row">
        {stages.map(([value, label]) => (
          <Col flex="1" key={value}>
            <section
              className="board-column"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                const item = items.find((entry) => entry.id === event.dataTransfer.getData('text/plain'))
                if (item) void transition(item, value)
              }}
            >
              <div className="board-heading"><strong>{label}</strong><span>{items.filter((item) => item.stage === value).length}</span></div>
              {items.filter((item) => item.stage === value).map((item) => (
                <Card key={item.id} size="small" hoverable draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', item.id)} onClick={() => openDetail(item)}>
                  <Typography.Text strong>{item.title}</Typography.Text>
                  <div><Typography.Text type="secondary">{item.platform || '未选平台'}{item.target_date ? ` · ${item.target_date}` : ''}</Typography.Text></div>
                </Card>
              ))}
            </section>
          </Col>
        ))}
      </Row>
      <Modal title="记录内容灵感" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={() => createForm.submit()} okText="保存">
        <Form form={createForm} layout="vertical" onFinish={(values) => void create(values)}>
          <Form.Item name="title" label="标题" rules={[{ required: true }]}><Input /></Form.Item>
          <Row gutter={12}><Col span={12}><Form.Item name="platform" label="平台"><Input /></Form.Item></Col><Col span={12}><Form.Item name="content_type" label="形式"><Input placeholder="文章、视频、图文" /></Form.Item></Col></Row>
          <Form.Item name="target_date" label="计划发布日期"><DatePicker /></Form.Item>
        </Form>
      </Modal>
      <EntityDrawer title={selected?.title ?? '内容详情'} open={Boolean(selected)} onClose={() => setSelected(null)} footer={<Space><Button onClick={() => setMetricOpen(true)} disabled={!selected}>记录表现</Button><Button type="primary" onClick={() => void saveDetail()}>保存</Button></Space>}>
        <Form form={editForm} layout="vertical">
          <Form.Item name="title" label="标题" rules={[{ required: true }]}><Input /></Form.Item>
          <Row gutter={12}><Col span={12}><Form.Item name="platform" label="平台"><Input /></Form.Item></Col><Col span={12}><Form.Item name="content_type" label="形式"><Input /></Form.Item></Col></Row>
          <Form.Item name="stage" label="阶段"><Select options={stages.map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item name="target_date" label="计划发布日期"><DatePicker /></Form.Item>
          <Form.Item name="outline" label="内容大纲"><Input.TextArea rows={4} /></Form.Item>
          <Form.Item name="body" label="正文或脚本"><Input.TextArea rows={10} /></Form.Item>
          <Form.Item name="reference_links" label="参考链接"><Input.TextArea rows={2} /></Form.Item>
          <Form.Item name="publish_link" label="发布链接"><Input /></Form.Item>
          <Form.Item name="notes" label="备注"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </EntityDrawer>
      <Modal title="记录发布表现" open={metricOpen} onCancel={() => setMetricOpen(false)} onOk={() => void addMetric()}>
        <Form form={metricForm} layout="vertical" initialValues={{ recorded_on: dayjs(), views: 0, likes: 0, comments: 0, favorites: 0 }}>
          <Form.Item name="recorded_on" label="记录日期"><DatePicker /></Form.Item>
          <Row gutter={8}>{['views', 'likes', 'comments', 'favorites'].map((name, index) => <Col span={6} key={name}><Form.Item name={name} label={['阅读', '点赞', '评论', '收藏'][index]}><InputNumber min={0} /></Form.Item></Col>)}</Row>
        </Form>
      </Modal>
    </div>
  )
}
