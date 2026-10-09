import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Space, Typography } from 'antd'
import { apiRequest } from '../api/client'

type FocusState = { date: string; seconds: number; running: { id: string; goal_id: string; task_id: string | null; started_at: string } | null }

function formatSeconds(value: number) {
  const safe = Math.max(0, Math.floor(value))
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`
}

export function FocusTimer({ goalId, tasks }: { goalId: string; tasks: Array<{ id: string; title: string }> }) {
  const [data, setData] = useState<FocusState | null>(null)
  const [taskId, setTaskId] = useState('')
  const [fetchedAt, setFetchedAt] = useState(Date.now())
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    const result = await apiRequest<FocusState>(`/learning/focus/today?offset_minutes=${new Date().getTimezoneOffset()}`)
    setData(result); setFetchedAt(Date.now()); setNow(Date.now()); setError('')
  }, [])
  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : '读取专注记录失败')) }, [goalId, load])
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [])

  async function toggle() {
    if (busy) return
    setBusy(true); setError('')
    try {
      await apiRequest(data?.running ? '/learning/focus/stop' : '/learning/focus/start', {
        method: 'POST',
        body: JSON.stringify(data?.running ? {} : { goal_id: goalId, task_id: taskId || null }),
      })
      await load()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '专注记录保存失败') }
    finally { setBusy(false) }
  }

  const running = data?.running
  const liveSeconds = running ? Math.max(0, Math.floor((now - new Date(running.started_at).getTime()) / 1000)) : 0
  const totalSeconds = (data?.seconds ?? 0) + (running ? Math.max(0, Math.floor((now - fetchedAt) / 1000)) : 0)
  return <Card size="small" className="focus-timer" title="番茄钟 · 25 分钟专注">
    {error ? <Alert type="error" showIcon title={error} action={<Button onClick={() => void load()}>重试</Button>} /> : null}
    <Space wrap>
      <Typography.Text>本次 {formatSeconds(liveSeconds)} · {liveSeconds >= 1500 ? '已达到 25 分钟，可休息一下' : `距离 25 分钟还剩 ${formatSeconds(1500 - liveSeconds)}`}</Typography.Text>
      <Typography.Text strong>今日专注 {formatSeconds(totalSeconds)}</Typography.Text>
      {!running ? <label>关联任务 <select className="native-form-select" aria-label="关联学习任务" value={taskId} onChange={(event) => setTaskId(event.target.value)}><option value="">整个学习目标</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label> : null}
      <Button type="primary" loading={busy} disabled={!data || Boolean(running && running.goal_id !== goalId)} onClick={() => void toggle()}>{running ? '结束专注并计入时长' : '开始专注'}</Button>
    </Space>
    {running && running.goal_id !== goalId ? <Typography.Text type="secondary">另一学习目标正在专注，请切换回该目标结束。</Typography.Text> : null}
  </Card>
}
