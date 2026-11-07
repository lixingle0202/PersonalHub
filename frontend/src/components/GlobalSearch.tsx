import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Empty, Input, Modal, Space, Spin, Tabs, Tag, Typography } from 'antd'
import dayjs from 'dayjs'
import { useNavigate } from 'react-router-dom'
import { apiRequest } from '../api/client'
import './SearchAssistant.css'

export type SearchResult = { id: string; module: string; type: string; title: string; snippet: string; path: string; date?: string | null; status?: string | null }
type Conditions = { keyword: string; category: string; status: string; start_date: string | null; end_date: string | null; mode: string }
type Comparison = {
  planned_count: number; completed_count: number; pending_count: number; completion_rate: number | null
  planned_learning_minutes: number | null; missing_estimate_count: number
  manual_learning_minutes: number | null; manual_record_count: number
  focus_minutes: number | null; focus_record_count: number; activity_count: number
  note: string; evidence: SearchResult[]; evidence_count: number
}
export type AssistedSearch = { interpretation: Conditions; results: SearchResult[]; total_count: number; warnings: string[]; comparison: Comparison }
const visibleModules = new Set(['today', 'learning', 'diet', 'home'])
const categories = { all: '全部', learning: '学习', diet: '饮食', exercise: '运动', work: '工作', health: '健康', life: '生活', leisure: '休闲', other: '其他', notes: '备忘' }
const statusNames: Record<string, string> = { all: '全部状态', pending: '未完成', completed: '已完成' }
const examples = ['找出上周没完成的英语任务', '查看昨天的运动记录', '这周学习计划与实际对照']

export function visibleSearchResults(results: SearchResult[]) {
  return results.filter((item) => visibleModules.has(item.module))
}

export function GlobalSearch() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [data, setData] = useState<AssistedSearch | null>(null)
  const [filters, setFilters] = useState<Conditions | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState('results')
  const controller = useRef<AbortController | null>(null)
  const navigate = useNavigate()
  useEffect(() => () => controller.current?.abort(), [])

  async function search(value: string, conditions?: Conditions, compare = false) {
    const clean = value.trim()
    if (!clean) { setError('请输入关键词或问题'); return }
    controller.current?.abort()
    const request = new AbortController()
    controller.current = request
    setQuery(clean); setOpen(true); setLoading(true); setError(''); setData(null)
    const params = new URLSearchParams({ q: clean, today: dayjs().format('YYYY-MM-DD'), offset_minutes: String(new Date().getTimezoneOffset()) })
    if (conditions) {
      params.set('category', conditions.category)
      params.set('status_filter', conditions.status)
      params.set('keyword', conditions.keyword)
      if (conditions.start_date) params.set('start_date', conditions.start_date)
      if (conditions.end_date) params.set('end_date', conditions.end_date)
      if (!conditions.start_date && !conditions.end_date) params.set('all_dates', 'true')
    }
    if (compare) params.set('mode', 'compare')
    try {
      const next = await apiRequest<AssistedSearch>(`/search/assist?${params}`, { signal: request.signal })
      if (request.signal.aborted) return
      setData(next); setFilters(next.interpretation)
      setActiveTab(next.interpretation.mode === 'compare' ? 'compare' : 'results')
    } catch (reason) {
      if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : '查询失败，请重试')
    } finally {
      if (!request.signal.aborted) setLoading(false)
    }
  }

  function close() {
    controller.current?.abort()
    setOpen(false); setLoading(false)
  }

  function resultsList(items: SearchResult[]) {
    const visible = visibleSearchResults(items)
    return <div className="search-results">
      {visible.map((item) => <button type="button" key={`${item.type}-${item.id}`} onClick={() => { close(); navigate(item.path) }}>
        <div><Tag>{item.type}</Tag><Typography.Text strong>{item.title}</Typography.Text></div>
        {item.snippet ? <Typography.Text type="secondary">{item.snippet}</Typography.Text> : null}
        <Typography.Text type="secondary" className="search-result-meta">{[item.date, statusNames[item.status ?? '']].filter(Boolean).join(' · ')}</Typography.Text>
      </button>)}
      {!visible.length ? <Empty description="没有找到匹配内容" /> : null}
    </div>
  }

  function comparisonPanel() {
    if (!data) return null
    const c = data.comparison
    const range = data.interpretation
    if (!range.start_date) return <Button onClick={() => void search(query, undefined, true)}>查看本周计划与实际</Button>
    const minutes = (value: number | null) => value == null ? '未记录' : `${value} 分钟`
    return <div className="search-comparison">
      <Typography.Text>{range.start_date} 至 {range.end_date} · {categories[range.category as keyof typeof categories]}{range.keyword ? ` · ${range.keyword}` : ''}</Typography.Text>
      <div className="search-comparison-stats">
        <div><small>计划事项</small><strong>{c.planned_count} 项</strong></div>
        <div><small>已完成 / 未完成</small><strong>{c.completed_count} / {c.pending_count}</strong></div>
        <div><small>计划完成率</small><strong>{c.completion_rate == null ? '无计划' : `${c.completion_rate}%`}</strong></div>
        <div><small>预计学习时长</small><strong>{minutes(c.planned_learning_minutes)}</strong>{c.missing_estimate_count ? <div>{c.missing_estimate_count} 项未填预计时长</div> : null}</div>
        <div><small>手动学习记录 · {c.manual_record_count} 条</small><strong>{minutes(c.manual_learning_minutes)}</strong></div>
        <div><small>已结束的专注计时 · {c.focus_record_count} 次</small><strong>{minutes(c.focus_minutes)}</strong></div>
      </div>
      <Typography.Paragraph className="search-guidance">日常活动 {c.activity_count} 条。{c.note}</Typography.Paragraph>
      <Typography.Paragraph type="secondary" className="search-guidance">对照按时间、类别与关键词统计全部计划，不受完成状态筛选影响；当前状态按计划日期归组，并非该日期内的完成动作次数。</Typography.Paragraph>
      <Typography.Title level={5}>查看统计来源（{c.evidence_count} 条）</Typography.Title>
      {c.evidence_count > c.evidence.length ? <Typography.Paragraph type="secondary">当前显示前 {c.evidence.length} 条来源；上方统计包含全部匹配数据，可缩小范围查看。</Typography.Paragraph> : null}
      {resultsList(c.evidence)}
    </div>
  }

  return <>
    <Input.Search aria-label="全局搜索" placeholder="搜索或提问" className="global-search" onSearch={(value, event) => { event?.preventDefault(); void search(value) }} loading={loading} />
    <Modal title="自然语言搜索与计划对照" className="search-assistant" width={900} open={open} onCancel={close} footer={null}>
      <Input.Search aria-label="自然语言查询" autoFocus value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} onSearch={(value, event) => { event?.preventDefault(); void search(value) }} enterButton="查询" />
      <div className="search-examples">{examples.map((example) => <Button key={example} size="small" disabled={loading} onClick={() => void search(example)}>{example}</Button>)}</div>
      {error ? <Alert type="error" showIcon title={error} action={<Button size="small" aria-label="重试查询" onClick={() => void search(query)}>重试</Button>} /> : null}
      {loading ? <div role="status"><Spin /> 正在查询个人记录</div> : null}
      {data && filters ? <>
        <div className="search-conditions">
          <Typography.Text strong>识别出的条件，可修改</Typography.Text>
          <div className="search-filter-grid">
            <label>开始日期<input type="date" className="native-form-select" value={filters.start_date ?? ''} onChange={(event) => setFilters({ ...filters, start_date: event.target.value || null })} /></label>
            <label>结束日期<input type="date" className="native-form-select" value={filters.end_date ?? ''} onChange={(event) => setFilters({ ...filters, end_date: event.target.value || null })} /></label>
            <label>类别<select className="native-form-select" value={filters.category} onChange={(event) => setFilters({ ...filters, category: event.target.value })}>{Object.entries(categories).map(([value, name]) => <option value={value} key={value}>{name}</option>)}</select></label>
            <label>完成状态<select className="native-form-select" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>{Object.entries(statusNames).map(([value, name]) => <option value={value} key={value}>{name}</option>)}</select></label>
            <label>关键词<Input value={filters.keyword} onChange={(event) => setFilters({ ...filters, keyword: event.target.value })} /></label>
            <Space><Button onClick={() => void search(query, filters)}>按条件查询</Button><Button onClick={() => void search(query)}>重新识别</Button></Space>
          </div>
        </div>
        <Typography.Paragraph type="secondary" className="search-guidance">{data.warnings.join(' ')}</Typography.Paragraph>
        <Tabs activeKey={activeTab} onChange={(key) => {
          if (key === 'compare' && !data.interpretation.start_date) void search(query, undefined, true)
          else setActiveTab(key)
        }} items={[
          { key: 'results', label: `搜索结果（${data.total_count}）`, children: <>{data.total_count > data.results.length ? <Typography.Paragraph>当前显示前 {data.results.length} 条，请缩小条件查看。</Typography.Paragraph> : null}{resultsList(data.results)}</> },
          { key: 'compare', label: '计划与实际', children: comparisonPanel() },
        ]} />
      </> : null}
    </Modal>
  </>
}
