import { CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined } from '@ant-design/icons'
import { Tag } from 'antd'

export type SaveState = 'idle' | 'saving' | 'saved' | 'failed'

const labels: Record<SaveState, string> = {
  idle: '等待修改',
  saving: '保存中',
  saved: '已保存',
  failed: '保存失败',
}

export function SaveStatus({ state }: { state: SaveState }) {
  if (state === 'saving') return <Tag icon={<LoadingOutlined />} color="processing">{labels[state]}</Tag>
  if (state === 'failed') return <Tag icon={<CloseCircleOutlined />} color="error">{labels[state]}</Tag>
  if (state === 'saved') return <Tag icon={<CheckCircleOutlined />} color="success">{labels[state]}</Tag>
  return <Tag>{labels[state]}</Tag>
}
