import { useEffect, useState } from 'react'
import { Alert, Button, Card, Empty, Segmented, Space, Spin, Typography } from 'antd'
import dayjs from 'dayjs'
import { apiRequest } from '../api/client'
import './LearningTrends.css'

type TrendDay = { date: string; manual_minutes: number | null; focus_seconds: number | null; planned_tasks: number; completed_tasks: number }
type DurationSummary = { minutes: number; record_count: number; active_days: number; current_streak: number }
export type LearningTrendData = {
  start_date: string; end_date: string; days: TrendDay[]
  manual: DurationSummary; focus: DurationSummary
  tasks: { planned: number; completed: number; completion_rate: number | null }
}
type Source = 'manual' | 'focus'
const minutesLabel = (value: number) => value > 0 && value < 0.1 ? '<0.1' : value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })
const duration = (day: TrendDay, source: Source) => source === 'manual' ? day.manual_minutes : day.focus_seconds === null ? null : day.focus_seconds / 60

function TrendChart({ days, source, tasks = false }: { days: TrendDay[]; source: Source; tasks?: boolean }) {
  const width = Math.max(360, days.length * 22 + 68)
  const left = 48, top = 22, height = 150, bottom = top + height
  const step = (width - left - 20) / days.length
  const maximum = Math.max(1, ...days.map((day) => tasks ? day.planned_tasks : duration(day, source) ?? 0))
  const ceiling = Math.ceil(maximum / (tasks ? 1 : maximum <= 10 ? 1 : 10)) * (tasks ? 1 : maximum <= 10 ? 1 : 10)
  const labelEvery = days.length <= 7 ? 1 : days.length <= 30 ? 5 : 10
  return <div className="learning-trend-scroll" tabIndex={0} aria-label={tasks ? '任务趋势，可横向滚动' : '学习时长趋势，可横向滚动'}>
    <svg width={width} viewBox={`0 0 ${width} 208`} role="img" aria-label={tasks ? '每日任务完成趋势图' : '每日学习时长柱状图'}>
      {[0, 0.5, 1].map((fraction) => <g key={fraction}>
        <line className="trend-grid-line" x1={left} y1={bottom - height * fraction} x2={width - 20} y2={bottom - height * fraction} />
        <text x={left - 8} y={bottom - height * fraction + 4} textAnchor="end">{tasks ? Number.isInteger(ceiling * fraction) ? ceiling * fraction : '' : minutesLabel(ceiling * fraction)}</text>
      </g>)}
      <text x={left} y={12}>{tasks ? '项' : '分钟'}</text>
      {days.map((day, index) => {
        const value = tasks ? day.planned_tasks : duration(day, source)
        const barHeight = value ? Math.max(2, value / ceiling * height) : 0
        const completedHeight = day.completed_tasks ? Math.max(2, day.completed_tasks / ceiling * height) : 0
        const x = left + step * (index + 0.5)
        const label = `${day.date}：${tasks ? `已完成 ${day.completed_tasks} / 计划 ${day.planned_tasks} 项` : value === null ? '未记录' : `${minutesLabel(value)} 分钟`}`
        return <g key={day.date} tabIndex={0} role="img" aria-label={label}>
          <title>{label}</title>
          <rect x={x - step * 0.35} y={top} width={step * 0.7} height={height} fill="transparent" />
          {barHeight ? <rect className={tasks ? 'trend-planned-bar' : 'trend-duration-bar'} x={x - step * 0.25} y={bottom - barHeight} width={step * 0.5} height={barHeight} rx={3} /> : <circle className="trend-no-data" cx={x} cy={bottom} r={2} />}
          {tasks && completedHeight ? <rect className="trend-completed-bar" x={x - step * 0.25} y={bottom - completedHeight} width={step * 0.5} height={completedHeight} rx={3} /> : null}
          {index % labelEvery === 0 || index === days.length - 1 ? <text x={x} y={194} textAnchor="middle">{day.date.slice(5).replace('-', '/')}</text> : null}
        </g>
      })}
    </svg>
  </div>
}

export function LearningTrends({ goals, revision = 0 }: { goals: Array<{ id: string; name: string }>; revision?: number }) {
  const [days, setDays] = useState(7)
  const [goalId, setGoalId] = useState('')
  const [source, setSource] = useState<Source>('manual')
  const [data, setData] = useState<LearningTrendData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [calendar, setCalendar] = useState(() => ({ today: dayjs().format('YYYY-MM-DD'), offset: new Date().getTimezoneOffset() }))
  const scope = goals.some((goal) => goal.id === goalId) ? goalId : ''
  useEffect(() => {
    const update = () => {
      const today = dayjs().format('YYYY-MM-DD'), offset = new Date().getTimezoneOffset()
      setCalendar((old) => old.today === today && old.offset === offset ? old : { today, offset })
    }
    const onVisible = () => { if (document.visibilityState === 'visible') { update(); setRefresh((value) => value + 1) } }
    const timer = window.setInterval(update, 60_000)
    document.addEventListener('visibilitychange', onVisible)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setData(null)
    const params = new URLSearchParams({ today: calendar.today, offset_minutes: String(calendar.offset), days: String(days) })
    if (scope) params.set('goal_id', scope)
    void apiRequest<LearningTrendData>(`/learning/trends?${params}`, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setData(result)
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '读取学习趋势失败')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [calendar, days, scope, revision, refresh])

  const summary = data?.[source]
  const sourceName = source === 'manual' ? '手动记录' : '专注计时'
  return <Card title="学习趋势" className="learning-trends" extra={<Button onClick={() => setRefresh((value) => value + 1)} loading={loading}>刷新趋势</Button>}>
    <div className="learning-trend-toolbar">
      <Space wrap>
        <Segmented aria-label="趋势时间范围" options={[{ label: '近7天', value: 7 }, { label: '近30天', value: 30 }, { label: '近90天', value: 90 }]} value={days} onChange={setDays} />
        <label>目标 <select className="native-form-select" aria-label="趋势学习目标" value={scope} onChange={(event) => setGoalId(event.target.value)}>
          <option value="">全部目标</option>{goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.name}</option>)}
        </select></label>
      </Space>
      <Segmented aria-label="学习时长来源" options={[{ label: '手动记录', value: 'manual' }, { label: '专注计时', value: 'focus' }]} value={source} onChange={(value) => setSource(value as Source)} />
    </div>
    {loading ? <div className="learning-trend-loading" role="status"><Spin /> 正在读取学习趋势</div> : error ? <Alert type="error" showIcon title={error} action={<Button onClick={() => setRefresh((value) => value + 1)}>重试</Button>} /> : data && summary ? <>
      <Typography.Paragraph type="secondary" className="learning-trend-caption">{data.start_date} — {data.end_date} · {sourceName}与其他来源分开统计</Typography.Paragraph>
      <div className="learning-trend-metrics">
        <div><span>累计学习 · 分钟</span><strong data-testid="trend-minutes">{summary.record_count ? minutesLabel(summary.minutes) : '未记录'}</strong></div>
        <div><span>区间学习 · 天</span><strong>{summary.active_days}</strong></div>
        <div><span>连续学习 · 天</span><strong data-testid="trend-streak">{summary.current_streak}</strong></div>
        <div><span>任务完成率</span><strong data-testid="trend-completion">{data.tasks.completion_rate === null ? '暂无任务' : `${data.tasks.completion_rate}%`}</strong><small>{data.tasks.completed} / {data.tasks.planned} 项</small></div>
      </div>
      {!summary.record_count && !data.tasks.planned ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无学习数据，记录学习或结束专注后即可查看" /> : null}
      <div className="learning-trend-charts">
        <section><h3>每日学习时长 <small>{sourceName}</small></h3><TrendChart days={data.days} source={source} /></section>
        <section><h3>任务完成趋势 <small><i className="trend-key-done" />已完成 <i className="trend-key-pending" />未完成</small></h3><TrendChart days={data.days} source={source} tasks /></section>
      </div>
      <Typography.Paragraph type="secondary" className="learning-trend-caption">连续天数截至今天或昨天；任务按计划日期统计当前完成状态。</Typography.Paragraph>
      <details className="learning-trend-details"><summary>查看每日明细</summary><div className="learning-trend-scroll"><table>
        <caption>{sourceName}每日明细</caption><thead><tr><th>日期</th><th>学习分钟</th><th>已完成 / 计划任务</th></tr></thead>
        <tbody>{data.days.map((day) => <tr key={day.date}><td>{day.date}</td><td>{duration(day, source) === null ? '未记录' : minutesLabel(duration(day, source)!)}</td><td>{day.completed_tasks} / {day.planned_tasks}</td></tr>)}</tbody>
      </table></div></details>
    </> : null}
  </Card>
}
