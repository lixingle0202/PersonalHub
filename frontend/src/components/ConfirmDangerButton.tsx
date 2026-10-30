import { Button, Popconfirm } from 'antd'

export function ConfirmDangerButton({
  label,
  title,
  description,
  onConfirm,
  disabled,
  ariaLabel,
}: {
  label: string
  title: string
  description: string
  onConfirm: () => void | Promise<void>
  disabled?: boolean
  ariaLabel?: string
}) {
  return (
    <Popconfirm
      title={title}
      description={description}
      okText="确认"
      cancelText="取消"
      okButtonProps={{ danger: true }}
      onConfirm={onConfirm}
      disabled={disabled}
    >
      <Button aria-label={ariaLabel ?? label} danger disabled={disabled}>{label}</Button>
    </Popconfirm>
  )
}
