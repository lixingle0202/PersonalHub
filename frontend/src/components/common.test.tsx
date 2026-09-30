import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDangerButton } from './ConfirmDangerButton'
import { EmptyStatePanel, ErrorPanel, LoadingPanel } from './StatePanels'
import { SaveStatus } from './SaveStatus'

describe('shared interaction components', () => {
  it.each([
    ['idle', '等待修改'],
    ['saving', '保存中'],
    ['saved', '已保存'],
    ['failed', '保存失败'],
  ] as const)('renders %s save state', (state, label) => {
    render(<SaveStatus state={state} />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('renders loading, empty and retry states', async () => {
    const user = userEvent.setup()
    const create = vi.fn()
    const retry = vi.fn()
    const { rerender } = render(<LoadingPanel />)
    expect(screen.getByLabelText('正在加载')).toBeInTheDocument()
    rerender(<EmptyStatePanel description="没有内容" actionLabel="创建" onAction={create} />)
    await user.click(screen.getByRole('button', { name: /创\s*建/ }))
    expect(create).toHaveBeenCalledOnce()
    rerender(<ErrorPanel message="连接失败" onRetry={retry} />)
    await user.click(screen.getByRole('button', { name: '重新加载' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('requires confirmation for destructive actions', async () => {
    const user = userEvent.setup()
    const remove = vi.fn()
    render(
      <ConfirmDangerButton
        label="永久删除"
        title="确认永久删除？"
        description="此操作无法恢复"
        onConfirm={remove}
      />,
    )
    await user.click(screen.getByRole('button', { name: '永久删除' }))
    expect(remove).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /确\s*认/ }))
    expect(remove).toHaveBeenCalledOnce()
  })
})
