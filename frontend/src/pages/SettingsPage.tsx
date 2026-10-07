import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button, Card, Col, ColorPicker, Empty, Form, Input, InputNumber, Row, Select, Switch, Tabs, Tag, Typography, message } from 'antd'
import { apiRequest, bootstrapApi } from '../api/client'
import { applyAppearance } from '../app/theme'
import { ConfirmDangerButton } from '../components/ConfirmDangerButton'
import { OllamaSettingsPanel } from '../components/OllamaSettingsPanel'
import { ErrorPanel, LoadingPanel } from '../components/StatePanels'

type AppSettings = {
  nickname: string; theme_mode: 'light' | 'dark'; theme_color: string; week_starts_on: 0 | 1
  default_work_start: string; default_work_end: string; default_study_minutes: number
  custom_categories: Record<string, string[]>
}

type Backup = {
  name: string; created_at: string; size_bytes: number; sha256: string
  kind: 'manual' | 'pre_restore' | 'automatic'
}

type TrashItem = {
  type: string; id: string; module: string; label: string; title: string; deleted_at: string
}

function readableSize(size: number) {
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`
}

export function SettingsPage() {
  const [searchParams] = useSearchParams()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [databasePath, setDatabasePath] = useState('')
  const [backups, setBackups] = useState<Backup[]>([])
  const [trash, setTrash] = useState<TrashItem[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try {
      const [values, bootstrap, backupValues, trashValues] = await Promise.all([
        apiRequest<AppSettings>('/settings'), bootstrapApi(), apiRequest<Backup[]>('/backups'), apiRequest<TrashItem[]>('/trash'),
      ])
      setSettings(values)
      setDatabasePath(bootstrap.database_path)
      setBackups(Array.isArray(backupValues) ? backupValues : [])
      setTrash(Array.isArray(trashValues) ? trashValues : [])
      applyAppearance(values)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取失败')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function runAction(key: string, action: () => Promise<unknown>, success: string) {
    setBusy(key)
    try {
      await action()
      message.success(success)
      await load()
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '操作失败')
    } finally {
      setBusy('')
    }
  }

  async function save(values: Record<string, unknown>) {
    const color = values.theme_color as { toHexString?: () => string } | string
    const payload = {
      ...values,
      theme_mode: values.dark ? 'dark' : 'light',
      theme_color: typeof color === 'string' ? color : color.toHexString?.(),
      dark: undefined,
    }
    const updated = await apiRequest<AppSettings>('/settings', { method: 'PATCH', body: JSON.stringify(payload) })
    setSettings(updated)
    applyAppearance(updated)
    window.dispatchEvent(new CustomEvent('personalhub-settings', { detail: updated }))
    message.success('设置已保存')
  }

  if (error) return <ErrorPanel message={error} onRetry={() => void load()} />
  if (!settings) return <LoadingPanel />

  const dataPanel = <div className="page-stack">
    <Card title="本地数据文件" extra={<Button type="primary" loading={busy === 'backup'} onClick={() => void runAction('backup', () => apiRequest('/backups', { method: 'POST' }), '备份已创建')}>立即备份</Button>}>
      <Typography.Paragraph>正式数据保存在独立文件中，不依赖浏览器缓存。恢复前会自动保存当前数据，选中的备份文件也不会被改写。</Typography.Paragraph>
      <Input value={databasePath} readOnly aria-label="数据库文件位置" />
    </Card>
    <Card title={`备份记录（${backups.length}）`}>
      {backups.length ? <div className="data-list">{backups.map((backup) => <div className="data-row" key={backup.name}>
        <div><Typography.Text strong>{new Date(backup.created_at).toLocaleString()}</Typography.Text><div><Tag>{backup.kind === 'pre_restore' ? '恢复前自动备份' : '手动备份'}</Tag><Typography.Text type="secondary">{readableSize(backup.size_bytes)} · 校验 {backup.sha256.slice(0, 10)}</Typography.Text></div></div>
        <ConfirmDangerButton label="恢复此备份" title="确认恢复数据？" description="当前数据会先自动备份，然后替换为这个版本。" disabled={Boolean(busy)} onConfirm={() => runAction(`restore-${backup.name}`, () => apiRequest(`/backups/${encodeURIComponent(backup.name)}/restore`, { method: 'POST' }), '数据已恢复')} />
      </div>)}</div> : <Empty description="还没有备份" />}
    </Card>
    <Card title={`回收站（${trash.length}）`}>
      {trash.length ? <div className="data-list">{trash.map((item) => <div className="data-row" key={`${item.type}-${item.id}`}>
        <div><Typography.Text strong>{item.title}</Typography.Text><div><Tag>{item.label}</Tag><Typography.Text type="secondary">删除于 {new Date(item.deleted_at).toLocaleString()}</Typography.Text></div></div>
        <div className="row-actions"><Button disabled={Boolean(busy)} onClick={() => void runAction(`restore-trash-${item.id}`, () => apiRequest(`/trash/${item.type}/${item.id}/restore`, { method: 'POST' }), '项目已恢复')}>恢复</Button><ConfirmDangerButton label="永久删除" title="永久删除这个项目？" description="此操作无法撤销。" disabled={Boolean(busy)} onConfirm={() => runAction(`purge-${item.id}`, () => apiRequest(`/trash/${item.type}/${item.id}`, { method: 'DELETE' }), '项目已永久删除')} /></div>
      </div>)}</div> : <Empty description="回收站是空的" />}
    </Card>
  </div>

  const preferencesPanel = <Card><Form key={`${settings.nickname}-${settings.theme_mode}-${settings.theme_color}-${settings.default_study_minutes}`} initialValues={{ ...settings, dark: settings.theme_mode === 'dark' }} layout="vertical" onFinish={(values) => void save(values)}>
    <Row gutter={16}><Col span={12}><Form.Item name="nickname" label="昵称"><Input /></Form.Item></Col><Col span={12}><Form.Item name="theme_color" label="主题颜色"><ColorPicker showText /></Form.Item></Col></Row>
    <Form.Item name="dark" label="深色模式" valuePropName="checked"><Switch /></Form.Item>
    <Row gutter={16}><Col span={8}><Form.Item name="week_starts_on" label="一周起始日"><Select options={[{ value: 1, label: '星期一' }, { value: 0, label: '星期日' }]} /></Form.Item></Col><Col span={8}><Form.Item name="default_work_start" label="默认工作开始"><Input placeholder="09:00" /></Form.Item></Col><Col span={8}><Form.Item name="default_work_end" label="默认工作结束"><Input placeholder="18:00" /></Form.Item></Col></Row>
    <Form.Item name="default_study_minutes" label="默认每日学习分钟"><InputNumber min={0} max={1440} /></Form.Item>
    <Button type="primary" htmlType="submit">保存设置</Button>
  </Form></Card>

  return <div className="page-stack"><Tabs defaultActiveKey={searchParams.get('tab') === 'ai' ? 'ai' : 'data'} items={[
    { key: 'data', label: '数据管理', children: dataPanel },
    { key: 'preferences', label: '个性化设置', children: preferencesPanel },
    { key: 'ai', label: '本地大模型', children: <OllamaSettingsPanel /> },
  ]} /></div>
}
