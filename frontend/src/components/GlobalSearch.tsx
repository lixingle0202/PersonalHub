import { useState } from 'react'
import { Empty, Input, Modal, Tag, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'
import { apiRequest } from '../api/client'

type SearchResult = { id: string; module: string; type: string; title: string; snippet: string; path: string }
const visibleModules = new Set(['today', 'learning', 'diet'])

export function visibleSearchResults(results: SearchResult[]) {
  return results.filter((item) => visibleModules.has(item.module))
}

export function GlobalSearch() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  async function search(value: string) {
    const clean = value.trim()
    if (!clean) return
    setQuery(clean); setOpen(true); setLoading(true)
    try { setResults(visibleSearchResults(await apiRequest<SearchResult[]>(`/search?q=${encodeURIComponent(clean)}`))) }
    finally { setLoading(false) }
  }

  return <>
    <Input.Search aria-label="全局搜索" placeholder="搜索全部内容" className="global-search" onSearch={(value) => void search(value)} loading={loading} />
    <Modal title={`搜索“${query}”`} open={open} onCancel={() => setOpen(false)} footer={null}>
      <div className="search-results">
        {results.map((item) => <button key={`${item.type}-${item.id}`} onClick={() => { setOpen(false); navigate(item.path) }}><div><Tag>{item.type}</Tag><Typography.Text strong>{item.title}</Typography.Text></div>{item.snippet ? <Typography.Text type="secondary">{item.snippet}</Typography.Text> : null}</button>)}
        {!loading && !results.length ? <Empty description="没有找到匹配内容" /> : null}
      </div>
    </Modal>
  </>
}
