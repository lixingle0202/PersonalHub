import { Alert, Button, Empty, Skeleton } from 'antd'

export function LoadingPanel() {
  return <div className="state-panel" aria-label="正在加载"><Skeleton active paragraph={{ rows: 5 }} /></div>
}

export function EmptyStatePanel({
  description,
  actionLabel,
  onAction,
}: {
  description: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="state-panel">
      <Empty description={description}>
        {actionLabel && onAction ? <Button type="primary" onClick={onAction}>{actionLabel}</Button> : null}
      </Empty>
    </div>
  )
}

export function ErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Alert
      type="error"
      showIcon
      title="读取失败"
      description={message}
      action={onRetry ? <Button onClick={onRetry}>重新加载</Button> : undefined}
    />
  )
}
