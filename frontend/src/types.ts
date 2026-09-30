export type AgendaItem = {
  id: string
  title: string
  plan_date: string
  start_time: string | null
  end_time: string | null
  priority: string
  bucket: 'must' | 'scheduled' | 'optional'
  status: 'pending' | 'completed' | 'cancelled'
  sort_order: number
  module: string
  source_type: string | null
  source_id: string | null
  notes: string
  completed_at: string | null
}

export type QuickNote = {
  id: string
  content: string
  is_important: boolean
  is_archived: boolean
  converted_type: string | null
  converted_id: string | null
  created_at: string
}

export type ModuleSummary = { title: string; count: number; detail?: string }

export type HomeData = {
  date: string
  stats: {
    total: number
    completed: number
    completion_rate: number
    must: number
    overdue: number
    due_soon: number
  }
  agenda: AgendaItem[]
  quick_notes: QuickNote[]
  summaries: Record<'media' | 'development' | 'consulting' | 'learning' | 'diet' | 'games', ModuleSummary>
}

export type DevProject = {
  id: string
  name: string
  goal: string
  description: string
  status: string
  start_date: string | null
  due_date: string | null
  progress: number
}

export type DevTask = {
  id: string
  project_id: string
  title: string
  description: string
  workflow_status: string
  agenda_id: string | null
  plan_date: string | null
  priority: string | null
  bucket: string | null
  agenda_status: string | null
}
