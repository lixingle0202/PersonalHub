import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { setLocalToken } from '../api/client'
import { DietPage } from './DietPage'

afterEach(() => vi.restoreAllMocks())

it('shows the calendar while a shopping-list request is still waiting', async () => {
  setLocalToken('diet-loading-test')
  let release!: (response: Response) => void
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = String(input)
    if (path.endsWith('/diet/shopping-lists')) return new Promise<Response>((resolve) => { release = resolve })
    if (path.endsWith('/diet/profile')) return json({ height_cm: null, weight_kg: null })
    if (path.includes('/diet/health/')) return json({ water_ml: 0, weight_kg: null, feeling: '' })
    return json([])
  })
  render(<DietPage />)
  expect(await screen.findByRole('table', { name: '饮食月历' })).toBeInTheDocument()
  await act(async () => { release(json([])) })
})
