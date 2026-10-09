import { useState } from 'react'
import { Alert, Button, Card, Form, Input, Typography } from 'antd'

type Credentials = { username: string; password: string }

export function PublicAuthPage() {
  const [register, setRegister] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(values: Credentials) {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/v1/public/' + (register ? 'register' : 'login'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values),
      })
      if (!response.ok) {
        const result = await response.json() as { detail?: string }
        throw new Error(typeof result.detail === 'string' ? result.detail : '操作失败（' + response.status + '）')
      }
      window.location.reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '连接失败，请重试')
      setBusy(false)
    }
  }

  return <main className="public-auth-layout">
    <Card className="public-auth-card">
      <div className="brand"><span className="brand-mark" aria-hidden="true">P</span><div><strong>PersonalHub</strong><span className="brand-caption">生活，有条不紊</span></div></div>
      <Typography.Title level={2}>{register ? '创建个人空间' : '欢迎回来'}</Typography.Title>
      <Typography.Paragraph type="secondary">每个人的计划和记录独立保存。AI 由主机上的共享模型生成，访问者无需安装 Ollama。</Typography.Paragraph>
      {error ? <Alert type="error" showIcon title={error} className="ai-status" /> : null}
      <Form layout="vertical" onFinish={(values) => void submit(values)}>
        <Form.Item name="username" label="用户名" rules={[{ required: true, min: 3, max: 32, pattern: /^[A-Za-z0-9_]+$/, message: '请输入 3 至 32 位英文字母、数字或下划线' }]}><Input autoComplete="username" /></Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true, min: 10, message: '密码至少 10 位' }]}><Input.Password autoComplete={register ? 'new-password' : 'current-password'} /></Form.Item>
        <Button type="primary" htmlType="submit" loading={busy} block>{register ? '注册并进入' : '登录'}</Button>
      </Form>
      <Button type="link" onClick={() => { setRegister((value) => !value); setError('') }} disabled={busy}>{register ? '已有账号？去登录' : '没有账号？创建个人空间'}</Button>
    </Card>
  </main>
}
