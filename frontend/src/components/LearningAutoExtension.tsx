import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { Alert, Button } from 'antd'
import { apiRequest } from '../api/client'

export type LearningExtensionNotice = {
  id: string
  goal_id: string
  goal_name: string
  triggered_on: string
  shifted_days: number
  previous_first_date: string
  new_first_date: string
}

type CheckResult = { shifted_goal_ids?: string[]; notices?: LearningExtensionNotice[] }

export function LearningAutoExtension({ children }: { children: ReactNode }) {
  const [checking, setChecking] = useState(true)
  const [notices, setNotices] = useState<LearningExtensionNotice[]>([])
  const [error, setError] = useState('')
  const [acknowledging, setAcknowledging] = useState('')
  const [revision, setRevision] = useState(0)

  async function check() {
    setChecking(true)
    try {
      const result = await apiRequest<CheckResult>('/learning/overdue/check', { method: 'POST' })
      setNotices(Array.isArray(result?.notices) ? result.notices : [])
      if (result?.shifted_goal_ids?.length) setRevision((value) => value + 1)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法检查学习计划是否逾期')
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    let active = true
    void apiRequest<CheckResult>('/learning/overdue/check', { method: 'POST' })
      .then((result) => {
        if (!active) return
        setNotices(Array.isArray(result?.notices) ? result.notices : [])
        if (result?.shifted_goal_ids?.length) setRevision((value) => value + 1)
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : '无法检查学习计划是否逾期')
      })
      .finally(() => { if (active) setChecking(false) })
    return () => { active = false }
  }, [])

  async function acknowledge(id: string) {
    setAcknowledging(id)
    try {
      await apiRequest(`/learning/overdue/reminders/${id}/ack`, { method: 'POST' })
      setNotices((current) => current.filter((notice) => notice.id !== id))
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '确认提醒失败，请重试')
    } finally {
      setAcknowledging('')
    }
  }

  return <div className="page-stack">
    {error ? <Alert type="warning" showIcon title="学习计划逾期检查暂不可用" description={error} action={<Button loading={checking} onClick={() => void check()}>重试检查</Button>} /> : null}
    {notices.map((notice) => <Alert key={notice.id} type="warning" showIcon
      title={`学习计划「${notice.goal_name}」已超时并自动顺延`}
      description={`连续 3 个自然日没有完成学习任务。未完成任务已顺延 ${notice.shifted_days} 天，最早一项从 ${notice.previous_first_date} 调整到 ${notice.new_first_date}；已完成任务保持不变。`}
      action={<Button loading={acknowledging === notice.id} aria-label={`确认收到 ${notice.goal_name} 顺延提醒`} onClick={() => void acknowledge(notice.id)}>我知道了</Button>}
    />)}
    <Fragment key={revision}>{children}</Fragment>
  </div>
}
