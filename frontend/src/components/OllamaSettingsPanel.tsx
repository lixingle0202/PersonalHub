import { useEffect, useState } from 'react'
import { Alert, AutoComplete, Button, Card, Form, Input, Space, Typography, message } from 'antd'
import { apiRequest, isPublicMode } from '../api/client'

export type OllamaSettings = { base_url: string; model: string }

export function OllamaSettingsPanel() {
  const [form] = Form.useForm<OllamaSettings>()
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)
  const hosted = isPublicMode()

  useEffect(() => {
    void apiRequest<OllamaSettings>('/ai/ollama/settings').then((values) => form.setFieldsValue(values)).catch((reason: Error) => setError(reason.message))
  }, [form])

  if (hosted) return <Card title="共享大模型"><Typography.Paragraph>学习计划由主机上的模型生成，你无需安装 Ollama。模型只会收到你在生成窗口填写的需求。</Typography.Paragraph><Typography.Text type="secondary">当前模型：qwen2.5:1.5b</Typography.Text></Card>

  async function refreshModels() {
    setBusy('models'); setError(''); setConnected(false)
    try {
      const base_url = form.getFieldValue('base_url')
      const result = await apiRequest<{ models: string[] }>('/ai/ollama/models', { method: 'POST', body: JSON.stringify({ base_url }) })
      setModels(result.models); setConnected(true)
      if (!form.getFieldValue('model') && result.models[0]) form.setFieldValue('model', result.models[0])
    } catch (reason) { setError(reason instanceof Error ? reason.message : '连接失败') }
    finally { setBusy('') }
  }

  async function save(values: OllamaSettings) {
    setBusy('save'); setError('')
    try {
      await apiRequest('/ai/ollama/settings', { method: 'PUT', body: JSON.stringify(values) })
      message.success('本地模型设置已保存')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败') }
    finally { setBusy('') }
  }

  return <Card title="本地大模型 · Ollama">
    <Typography.Paragraph>连接这台电脑上的 Ollama，为学习计划生成可编辑草稿。模型只会收到你在生成窗口填写的需求。</Typography.Paragraph>
    <Typography.Paragraph type="secondary">先安装并启动 <a href="https://ollama.com/download/windows" target="_blank" rel="noreferrer">Ollama</a>，下载一个模型，再点击“检查连接并刷新模型”。</Typography.Paragraph>
    <Form form={form} layout="vertical" initialValues={{ base_url: 'http://127.0.0.1:11434', model: '' }} onFinish={(values) => void save(values)}>
      <Form.Item name="base_url" label="Ollama 服务地址" rules={[{ required: true, message: '请输入本机服务地址' }]}><Input placeholder="http://127.0.0.1:11434" onChange={() => setConnected(false)} /></Form.Item>
      <Form.Item name="model" label="模型名称" rules={[{ required: true, whitespace: true, message: '请选择或填写已安装的模型名称' }]}><AutoComplete options={models.map((value) => ({ value }))} placeholder="刷新模型列表后选择，也可填写模型名称" filterOption={(value, option) => String(option?.value).toLowerCase().includes(value.toLowerCase())} /></Form.Item>
      {error ? <Alert type="error" showIcon title={error} className="ai-status" /> : null}
      {connected ? <Alert type={models.length ? 'success' : 'warning'} showIcon title={models.length ? `已连接，发现 ${models.length} 个本地模型` : '已连接 Ollama，但尚未安装模型。请先下载一个模型后刷新。'} className="ai-status" /> : null}
      <Space><Button loading={busy === 'models'} disabled={Boolean(busy)} onClick={() => void refreshModels()}>检查连接并刷新模型</Button><Button type="primary" htmlType="submit" loading={busy === 'save'} disabled={Boolean(busy)}>保存模型设置</Button></Space>
    </Form>
  </Card>
}
