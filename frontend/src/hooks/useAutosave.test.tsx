import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useAutosave } from './useAutosave'

describe('useAutosave', () => {
  it('debounces and reports a successful save', async () => {
    vi.useFakeTimers()
    const save = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useAutosave(save, 500))
    act(() => {
      result.current.schedule('first')
      result.current.schedule('latest')
    })
    expect(result.current.state).toBe('saving')
    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('latest')
    expect(result.current.state).toBe('saved')
    vi.useRealTimers()
  })

  it('keeps failed data available for retry', async () => {
    vi.useFakeTimers()
    const save = vi.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useAutosave(save, 100))
    act(() => result.current.schedule('draft'))
    await act(async () => vi.advanceTimersByTimeAsync(100))
    expect(result.current.state).toBe('failed')
    await act(async () => result.current.retry())
    expect(save).toHaveBeenCalledTimes(2)
    expect(result.current.state).toBe('saved')
    vi.useRealTimers()
  })
})
