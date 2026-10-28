import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import dayjs from 'dayjs'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { setLocalToken } from '../api/client'
import type { AgendaItem } from '../types'
import { TodayPage } from './TodayPage'

const date = dayjs().format('YYYY-MM-DD')
const item: AgendaItem = { id: 'manual', title: '去医院', plan_date: date, start_time: null, end_time: null,
  priority: 'normal', bucket: 'scheduled', status: 'pending', sort_order: 1, module: 'general',
  source_type: null, source_id: null, notes: '', completed_at: null }
const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
}))

beforeEach(() => { vi.restoreAllMocks(); setLocalToken('test-token') })

it('creates a manual plan, edits it after completing it, and confirms deletion', async () => {
  const user = userEvent.setup()
  let rows: AgendaItem[] = []
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input)
    if (init?.method === 'POST' && url.endsWith('/agenda')) {
      rows = [{ ...item, ...JSON.parse(String(init.body)) }]
      return response(rows[0], 201)
    }
    if (url.endsWith('/complete')) { rows = [{ ...rows[0], status: 'completed' }]; return response(rows[0]) }
    if (init?.method === 'PATCH') { rows = [{ ...rows[0], ...JSON.parse(String(init.body)) }]; return response(rows[0]) }
    if (init?.method === 'DELETE') { const removed = rows[0]; rows = []; return response(removed) }
    return response(rows)
  })
  render(<MemoryRouter><TodayPage /></MemoryRouter>)
  await user.click(await screen.findByRole('button', { name: '新增计划' }))
  await user.type(within(screen.getByRole('dialog')).getByLabelText('计划内容'), '去医院')
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /保\s*存/ }))
  await user.click(await screen.findByLabelText('完成 去医院'))
  await user.click(await screen.findByRole('button', { name: '编辑计划：去医院' }))
  const editor = within(screen.getByRole('dialog'))
  await user.clear(editor.getByLabelText('计划内容'))
  await user.type(editor.getByLabelText('计划内容'), '医院复诊')
  await user.type(editor.getByLabelText('备注'), '带报告')
  await user.click(editor.getByRole('button', { name: /保\s*存/ }))
  expect(await screen.findByLabelText('恢复未完成 医院复诊')).toBeChecked()
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/agenda/manual', expect.objectContaining({
    method: 'PATCH', body: JSON.stringify({ title: '医院复诊', plan_date: date, bucket: 'scheduled', priority: 'normal', notes: '带报告' }),
  }))
  await user.click(screen.getByRole('button', { name: '删除计划：医院复诊' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /取\s*消/ }))
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  await user.click(screen.getByRole('button', { name: '删除计划：医院复诊' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认删除' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '编辑计划：医院复诊' })).not.toBeInTheDocument())
  expect(rows).toEqual([])
}, 60000)

it('keeps edits open after a failed save, then allows retry', async () => {
  const user = userEvent.setup()
  let current = { ...item }
  let attempts = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation((_, init) => {
    if (init?.method === 'PATCH') {
      if (++attempts === 1) return response({ detail: '暂时无法保存' }, 503)
      current = { ...current, ...JSON.parse(String(init.body)) }
      return response(current)
    }
    return response([current])
  })
  render(<MemoryRouter><TodayPage /></MemoryRouter>)
  await user.click(await screen.findByRole('button', { name: '编辑计划：去医院' }))
  const editor = within(screen.getByRole('dialog'))
  await user.clear(editor.getByLabelText('计划内容'))
  await user.type(editor.getByLabelText('计划内容'), '复诊')
  await user.click(editor.getByRole('button', { name: /保\s*存/ }))
  expect(await screen.findByText('暂时无法保存')).toBeInTheDocument()
  expect(editor.getByLabelText('计划内容')).toHaveValue('复诊')
  await user.click(editor.getByRole('button', { name: /保\s*存/ }))
  expect(await screen.findByRole('button', { name: '编辑计划：复诊' })).toBeInTheDocument()
  expect(attempts).toBe(2)
}, 60000)
