import type { AssistedSearch, SearchResult } from '../components/GlobalSearch'

export function searchPayload(results: SearchResult[] = []): AssistedSearch {
  return {
    interpretation: { keyword: '', category: 'learning', status: 'all', start_date: '2026-11-02', end_date: '2026-11-08', mode: 'search' },
    results, total_count: results.length, warnings: ['支持时间、类别、状态与关键词组合。'],
    comparison: {
      planned_count: 2, completed_count: 1, pending_count: 1, completion_rate: 50,
      planned_learning_minutes: 45, missing_estimate_count: 1,
      manual_learning_minutes: 20, manual_record_count: 1, focus_minutes: 15, focus_record_count: 1,
      activity_count: 1, note: '手动学习记录与专注计时分别展示、不相加；未记录不代表实际为零。',
      evidence: results, evidence_count: results.length,
    },
  }
}
