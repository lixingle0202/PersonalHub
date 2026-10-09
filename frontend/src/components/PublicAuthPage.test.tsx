import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PublicAuthPage } from './PublicAuthPage'

describe('public account entry', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('validates registration before sending credentials and displays server errors', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: '用户名已被使用' }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    )
    render(<PublicAuthPage />)
    fireEvent.click(screen.getByRole('button', { name: '没有账号？创建个人空间' }))
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'short' } })
    fireEvent.click(screen.getByRole('button', { name: '注册并进入' }))
    await screen.findByText('密码至少 10 位')
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'long-private-password' } })
    fireEvent.click(screen.getByRole('button', { name: '注册并进入' }))
    expect(await screen.findByText('用户名已被使用')).toBeInTheDocument()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/v1/public/register', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ username: 'alice', password: 'long-private-password' }),
    })))
  })
})
