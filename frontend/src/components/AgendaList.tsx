import { CheckCircleFilled, ClockCircleOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons'
import { Button, Checkbox, Empty, Space, Tag, Typography } from 'antd'
import { Link } from 'react-router-dom'
import type { AgendaItem } from '../types'

const moduleNames: Record<string, string> = {
  general: '手动添加',
  media: '其他事项',
  development: '其他事项',
  consulting: '其他事项',
  learning: '学习计划',
  diet: '饮食计划',
}

function sourceLink(item: AgendaItem) {
  if (item.module === 'learning') return `/learning?item=${item.source_id ?? ''}`
  if (item.module === 'diet') return `/diet?item=${item.source_id ?? ''}`
  return null
}

export function AgendaList({
  items,
  onToggleComplete,
  onRescheduleTomorrow,
  onReorder,
  onEdit,
  onDelete,
  onClassify,
  compact = false, highlightId,
}: {
  items: AgendaItem[]
  onToggleComplete?: (item: AgendaItem) => void
  onRescheduleTomorrow?: (item: AgendaItem) => void
  onReorder?: (ordered: AgendaItem[]) => void
  onEdit?: (item: AgendaItem) => void
  onDelete?: (item: AgendaItem) => void
  onClassify?: (item: AgendaItem) => void
  compact?: boolean
  highlightId?: string | null
}) {
  if (!items.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有计划事项" />

  function dropOn(targetId: string, draggedId: string) {
    if (!onReorder || targetId === draggedId) return
    const next = [...items]
    const from = next.findIndex((item) => item.id === draggedId)
    const to = next.findIndex((item) => item.id === targetId)
    if (from < 0 || to < 0) return
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    onReorder(next)
  }

  return (
    <div className={`agenda-list ${compact ? 'compact' : ''}`}>
      {items.map((item) => {
        const link = sourceLink(item)
        return (
          <article
            id={`agenda-${item.id}`} data-search-target={item.id === highlightId}
            className={`agenda-row ${item.status}`}
            key={item.id}
            draggable={Boolean(onReorder)}
            onDragStart={(event) => event.dataTransfer.setData('text/plain', item.id)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => dropOn(item.id, event.dataTransfer.getData('text/plain'))}
          >
            <Checkbox
              aria-label={item.status === 'completed' ? `恢复未完成 ${item.title}` : `完成 ${item.title}`}
              checked={item.status === 'completed'}
              disabled={!onToggleComplete || item.status === 'cancelled'}
              onChange={() => onToggleComplete?.(item)}
            />
            <div className="agenda-main">
              <Space size={6} wrap>
                {item.status === 'completed' ? <CheckCircleFilled className="success-icon" /> : null}
                <Typography.Text delete={item.status === 'completed'} strong={item.bucket === 'must'}>
                  {link ? <Link to={link}>{item.title}</Link> : item.title}
                </Typography.Text>
                <Tag>{moduleNames[item.module] ?? item.module}</Tag>
                {item.priority === 'urgent' || item.priority === 'high' ? <Tag color="red">高优先级</Tag> : null}
              </Space>
              {item.notes ? <Typography.Text type="secondary">{item.notes}</Typography.Text> : null}
            </div>
            {item.start_time ? <span className="agenda-time"><ClockCircleOutlined /> {item.start_time}</span> : null}
            {onEdit || onDelete || onClassify ? <Space size={4} wrap className="agenda-actions">
              {onClassify && item.source_type ? <Button size="small" aria-label={`调整必要程度：${item.title}`} onClick={() => onClassify(item)}>调整分类</Button> : null}
              {!item.source_type ? <>
                {onEdit ? <Button size="small" icon={<EditOutlined />} aria-label={`编辑计划：${item.title}`} onClick={() => onEdit(item)}>编辑</Button> : null}
                {onDelete ? <Button size="small" danger icon={<DeleteOutlined />} aria-label={`删除计划：${item.title}`} onClick={() => onDelete(item)}>删除</Button> : null}
              </> : link ? <Link to={link}>编辑来源计划</Link> : null}
            </Space> : null}
            {onRescheduleTomorrow && item.status === 'pending' ? (
              <Button type="link" onClick={() => onRescheduleTomorrow(item)}>移到明天</Button>
            ) : null}
          </article>
        )
      })}
    </div>
  )
}
