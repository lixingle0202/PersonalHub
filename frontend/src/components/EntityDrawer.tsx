import type { ReactNode } from 'react'
import { Drawer } from 'antd'

export function EntityDrawer({
  title,
  open,
  onClose,
  children,
  footer,
}: {
  title: string
  open: boolean
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <Drawer title={title} size={560} open={open} onClose={onClose} destroyOnHidden footer={footer}>
      {children}
    </Drawer>
  )
}
