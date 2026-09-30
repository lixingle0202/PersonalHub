import { Button, Popconfirm } from 'antd'

export function ConfirmDangerButton({
  label,
  title,
  description,
  onConfirm,
  disabled,
}: {
  label: string
  title: string
  description: string
  onConfirm: () => void | Promise<void>
  disabled?: boolean
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
      <Button danger disabled={disabled}>{label}</Button>
    </Popconfirm>
  )
}
