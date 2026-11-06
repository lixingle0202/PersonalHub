import { useEffect, useState } from 'react'
import { Alert, AutoComplete, Button, Card, Form, Input, Radio, Select, Space, Typography, message } from 'antd'
import { apiRequest, isPublicMode, isDesktopMode } from '../api/client'
import { readVisitorModel, saveVisitorModel, visitorModels, type VisitorModelPreference } from '../api/visitorModel'

export type OllamaSettings = { base_url: string; model: string }

export function OllamaSettingsPanel() {
  if (isDesktopMode()) return <DesktopModelSettings />
  return isPublicMode() ? <VisitorModelSettings /> : <LocalModelSettings />
}

function DesktopModelSettings() {
  type Choice = OllamaSettings & { source: 'builtin' | 'local' }
  const [form] = Form.useForm<OllamaSettings>()
  const [source, setSource] = useState<Choice['source']>('builtin')
  const [status, setStatus] = useState<(Choice & { ready: boolean; detail?: string }) | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState('load')
  const [error, setError] = useState('')
  async function check() {
    setBusy('check'); setError('')
    try { setStatus(await apiRequest('/desktop/ai/status')) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '检查失败') }
    finally { setBusy('') }
  }
  useEffect(() => {
    void apiRequest<Choice>('/desktop/ai/settings').then(async (choice) => {
      setSource(choice.source)
      if (choice.source === 'local') {
        form.setFieldsValue(choice)
        setModels([choice.model])
      }
      setStatus(await apiRequest('/desktop/ai/status'))
    }).catch((reason: Error) => setError(reason.message)).finally(() => setBusy(''))
  }, [form])

  async function refreshModels() {
    setBusy('models'); setError('')
    try {
      const result = await apiRequest<{ models: string[] }>('/desktop/ai/models', { method: 'POST', body: JSON.stringify({ base_url: form.getFieldValue('base_url') }) })
      setModels(result.models)
      if (!result.models.includes(form.getFieldValue('model'))) form.setFieldValue('model', result.models[0])
      if (!result.models.length) setError('此 Ollama 尚未下载模型。')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '连接失败') }
    finally { setBusy('') }
  }

  async function save(values: OllamaSettings) {
    setBusy('save'); setError('')
    try {
      const selected = await apiRequest<Choice>('/desktop/ai/settings', { method: 'PUT', body: JSON.stringify(source === 'builtin' ? { source } : { ...values, source }) })
      setStatus({ ...selected, ready: true })
      message.success('已切换，学习和饮食计划将使用此模型')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '切换失败') }
    finally { setBusy('') }
  }

  return <Card title="本机 AI · 模型切换">
    <Typography.Paragraph>学习计划和饮食计划共用所选模型，设置保存在当前账号。</Typography.Paragraph>
    {status ? <Alert type={status.ready ? 'success' : 'warning'} showIcon title={status.ready ? `当前使用 · ${status.source === 'builtin' ? '内置模型' : '本机 Ollama'} · ${status.model}` : `${status.model}：${status.detail ?? '连接失败'}`} /> : null}
    <Radio.Group aria-label="桌面模型来源" value={source} disabled={Boolean(busy)} style={{ marginTop: 20, marginBottom: 16 }} onChange={(event) => { setSource(event.target.value); setError('') }} options={[
      { label: '内置模型', value: 'builtin' }, { label: '其他本机 Ollama 模型', value: 'local' },
    ]} optionType="button" buttonStyle="solid" />
    <Form form={form} layout="vertical" initialValues={{ base_url: 'http://127.0.0.1:11434', model: '' }} onFinish={(values) => void save(values)} disabled={Boolean(busy)}>
      {source === 'local' ? <>
        <Typography.Paragraph type="secondary">先在 Ollama 中下载模型，再刷新列表选择。</Typography.Paragraph>
        <Form.Item name="base_url" label="Ollama 地址" rules={[{ required: true, message: '请输入本机服务地址' }]}><Input onChange={() => { setModels([]); form.setFieldValue('model', undefined) }} /></Form.Item>
        <Form.Item name="model" label="模型" rules={[{ required: true, message: '请刷新并选择已下载的模型' }]}><Select showSearch options={models.map((value) => ({ value, label: value }))} placeholder="刷新后选择已下载的模型" /></Form.Item>
      </> : <Typography.Paragraph type="secondary">qwen2.5:1.5b · 随软件启动，无需额外安装。</Typography.Paragraph>}
      {error ? <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} /> : null}
      <Space wrap>
        {source === 'local' ? <Button loading={busy === 'models'} onClick={() => void refreshModels()}>刷新模型列表</Button> : null}
        <Button type="primary" htmlType="submit" loading={busy === 'save'}>保存并切换</Button>
        <Button loading={busy === 'check'} onClick={() => void check()}>检查当前模型</Button>
      </Space>
    </Form>
  </Card>
}

function VisitorModelSettings() {
  const [form] = Form.useForm<OllamaSettings>()
  const [saved, setSaved] = useState(readVisitorModel)
  const [models, setModels] = useState<string[]>([])
  const [sharedModel, setSharedModel] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    void apiRequest<OllamaSettings>('/ai/ollama/settings').then((value) => setSharedModel(value.model)).catch((reason: Error) => setError(reason.message))
  }, [])

  function choose(provider: VisitorModelPreference['provider']) {
    const updated = { ...saved, provider }
    saveVisitorModel(updated)
    setSaved(updated)
    setError('')
  }

  async function refreshModels() {
    setBusy('models'); setError(''); setConnected(false)
    try {
      const found = await visitorModels(form.getFieldValue('base_url'))
      setModels(found); setConnected(true)
      if (!form.getFieldValue('model') && found[0]) form.setFieldValue('model', found[0])
    } catch (reason) { setError(reason instanceof Error ? reason.message : '连接失败') }
    finally { setBusy('') }
  }

  async function save(values: OllamaSettings) {
    setBusy('save'); setError('')
    try {
      const found = await visitorModels(values.base_url)
      if (!found.includes(values.model.trim())) throw new Error('所选模型尚未安装，请刷新列表并选择已安装的模型')
      const updated: VisitorModelPreference = { provider: 'local', base_url: values.base_url.trim(), model: values.model.trim() }
      saveVisitorModel(updated)
      setSaved(updated); setModels(found); setConnected(true)
      message.success('已切换到这台电脑的本地模型')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败') }
    finally { setBusy('') }
  }

  return <Card title="大模型来源">
    <Radio.Group aria-label="大模型来源" value={saved.provider} onChange={(event) => choose(event.target.value)} options={[
      { label: '共享大模型', value: 'shared' }, { label: '本地大模型', value: 'local' },
    ]} optionType="button" buttonStyle="solid" />
    {saved.provider === 'shared' ? <Typography.Paragraph style={{ marginTop: 20 }}>
      学习与饮食计划由网站配置的 {sharedModel || '共享模型'} 生成。无需在这台电脑安装模型。
    </Typography.Paragraph> : <div style={{ marginTop: 20 }}>
      <Typography.Paragraph>只连接这台电脑的 Ollama。模型推理在你的电脑上运行，生成的草稿仍保存在你自己的网页账号中。</Typography.Paragraph>
      <Typography.Paragraph type="secondary">先安装、启动 Ollama 并下载模型。Windows 用户可在“编辑账户的环境变量”中新建 <code>OLLAMA_ORIGINS</code>，值填下方完整网址；退出并重新启动 Ollama。浏览器如询问本地网络访问，请允许。临时网址变化后需更新该变量。无需开放 Ollama 端口。</Typography.Paragraph>
      <Typography.Text strong>需要允许的网页来源</Typography.Text>
      <Input aria-label="需要允许的网页来源" value={window.location.origin} readOnly style={{ marginTop: 8 }} />
      <Typography.Paragraph style={{ marginTop: 12 }}><a href="https://docs.ollama.com/faq#how-can-i-allow-additional-web-origins-to-access-ollama" target="_blank" rel="noreferrer">查看 Ollama 来源设置说明</a></Typography.Paragraph>
      <Form form={form} layout="vertical" initialValues={{ base_url: saved.base_url, model: saved.model }} onFinish={(values) => void save(values)}>
        <Form.Item name="base_url" label="这台电脑的 Ollama 地址" rules={[{ required: true, message: '请输入本机服务地址' }]}><Input placeholder="http://127.0.0.1:11434" onChange={() => setConnected(false)} /></Form.Item>
        <Form.Item name="model" label="本机模型名称" rules={[{ required: true, whitespace: true, message: '请选择已安装的模型' }]}><AutoComplete options={models.map((value) => ({ value }))} placeholder="刷新后选择已安装的模型" /></Form.Item>
        {connected ? <Alert type="success" showIcon title={`已连接，发现 ${models.length} 个本机模型`} className="ai-status" /> : null}
        <Space><Button loading={busy === 'models'} disabled={Boolean(busy)} onClick={() => void refreshModels()}>检查连接并刷新模型</Button><Button type="primary" htmlType="submit" loading={busy === 'save'} disabled={Boolean(busy)}>保存并使用本地模型</Button></Space>
      </Form>
    </div>}
    {error ? <Alert type="error" showIcon title={error} className="ai-status" style={{ marginTop: 16 }} /> : null}
  </Card>
}

function LocalModelSettings() {
  const [form] = Form.useForm<OllamaSettings>()
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    void apiRequest<OllamaSettings>('/ai/ollama/settings').then((values) => form.setFieldsValue(values)).catch((reason: Error) => setError(reason.message))
  }, [form])


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
