import { useEffect, useState } from 'react'
import { Button, Card, Empty, Modal, Tag, Typography } from 'antd'
import { ConfirmDangerButton } from './ConfirmDangerButton'

export type TrashItem = {
  type: string; id: string; module: string; label: string; title: string; deleted_at: string
  details?: string; plan_date?: string; status?: string
  goal_deleted?: boolean; parent_deleted?: boolean; children?: TrashItem[]
}

const learningKinds = [
  { type: 'learning_task', label: '每日学习任务' },
  { type: 'learning_section', label: '学习阶段' },
  { type: 'study_session', label: '学习记录' },
  { type: 'learning_resource', label: '笔记与资料' },
]

const categoryLabels: Record<string, string> = {
  learning: '学习', diet: '饮食', today: '今日计划', home: '日常记录',
  development: '开发项目', consulting: '咨询', media: '内容创作',
}

function groupLabel(item: TrashItem) {
  return item.type === 'shopping_list' ? '清单' : '计划'
}

export function TrashPanel({ items, busy, onRestore, onPurge, onRestoreCategory }: {
  items: TrashItem[]
  busy: boolean
  onRestore: (item: TrashItem) => Promise<void>
  onPurge: (item: TrashItem) => Promise<void>
  onRestoreCategory: (module: string) => Promise<void>
}) {
  const [openCategory, setOpenCategory] = useState<string | null>(null)
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  const categories = Object.entries(categoryLabels).map(([module, label]) => ({
    module, label, items: items.filter((item) => item.module === module),
  })).filter((category) => category.items.length)
  const category = categories.find((item) => item.module === openCategory)
  const selected = category?.items.find((item) => `${item.type}-${item.id}` === openGroup)

  useEffect(() => {
    if (openCategory && !items.some((item) => item.module === openCategory)) {
      setOpenCategory(null)
      setOpenGroup(null)
    } else if (openGroup && !items.some((item) => `${item.type}-${item.id}` === openGroup)) {
      setOpenGroup(null)
    }
  }, [items, openCategory, openGroup])

  function itemActions(item: TrashItem, nested = false) {
    const grouped = item.children !== undefined
    const noun = groupLabel(item)
    return <div className="row-actions">
      {grouped ? <Button onClick={() => setOpenGroup(`${item.type}-${item.id}`)}>查看内容</Button> : null}
      <Button disabled={busy} onClick={() => void onRestore(item)}>{grouped ? `恢复整个${noun}` : nested ? '恢复此项' : '恢复'}</Button>
      {!grouped || (item.parent_deleted ?? item.goal_deleted) ? <ConfirmDangerButton
        label={grouped ? `永久删除${noun}` : '永久删除'}
        title={grouped ? `永久删除整个${noun}？` : '永久删除这个项目？'}
        description={grouped ? `整个${noun}及其全部内容将永久删除，此操作无法撤销。` : '此操作无法撤销。'}
        disabled={busy} onConfirm={() => onPurge(item)}
      /> : null}
    </div>
  }

  function itemRow(item: TrashItem, nested = false) {
    return <article className="data-row" key={`${item.type}-${item.id}`} aria-label={item.title}>
      <div>
        <Typography.Text strong>{item.title}</Typography.Text>
        {nested ? null : <div><Tag>{item.label}</Tag><Typography.Text type="secondary">删除于 {new Date(item.deleted_at).toLocaleString()}</Typography.Text></div>}
        {item.children ? <Typography.Text type="secondary">{(item.parent_deleted ?? item.goal_deleted) ? `整个${groupLabel(item)}已删除` : '部分内容仍在回收站'} · {item.children.length} 项内容待恢复</Typography.Text> : null}
        {item.plan_date || item.status ? <Typography.Text type="secondary">{[item.plan_date, item.status ? item.status === 'completed' ? '已完成' : '未完成' : ''].filter(Boolean).join(' · ')}</Typography.Text> : null}
        {nested && item.details ? <Typography.Paragraph className="trash-item-details">{item.details}</Typography.Paragraph> : null}
      </div>
      {itemActions(item, nested)}
    </article>
  }

  return <>
    <Card title={`回收站（${categories.length} 类）`}>
      {categories.length ? <div className="data-list">{categories.map((item) => <div className="data-row" key={item.module}>
        <div>
          <Typography.Text strong>{item.label}</Typography.Text>
          <Typography.Text type="secondary">{item.items.length} 组已删除内容，可整体恢复或查看后逐条恢复</Typography.Text>
        </div>
        <div className="row-actions">
          <Button aria-label={`查看${item.label}回收站`} onClick={() => { setOpenCategory(item.module); setOpenGroup(null) }}>查看内容</Button>
          <Button aria-label={`恢复${item.label}全部内容`} disabled={busy} onClick={() => void onRestoreCategory(item.module)}>全部恢复</Button>
        </div>
      </div>)}</div> : <Empty description="回收站是空的" />}
    </Card>
    <Modal title={selected ? `${selected.label}：${selected.title}` : `${category?.label ?? ''}回收站`} open={Boolean(category)} onCancel={() => { setOpenCategory(null); setOpenGroup(null) }} footer={null} width={820} styles={{ body: { maxHeight: '65vh', overflowY: 'auto' } }}>
      {selected ? <div className="trash-plan-detail">
        <Button onClick={() => setOpenGroup(null)}>返回{category?.label}大类</Button>
        {selected.details ? <Typography.Paragraph>{selected.details}</Typography.Paragraph> : null}
        <Typography.Paragraph type="secondary">{selected.type === 'learning_goal' ? '恢复单项时会同时恢复所属计划及必要的学习阶段，其余内容继续保留在回收站。' : '恢复单个物品时会同时恢复所属清单，其余物品继续保留在回收站。'}</Typography.Paragraph>
        <Button type="primary" disabled={busy} onClick={() => void onRestore(selected)}>恢复整个{groupLabel(selected)}</Button>
        {(selected.type === 'learning_goal' ? learningKinds : [{ type: 'shopping_item', label: '购物物品' }]).map((kind) => {
          const children = selected.children?.filter((item) => item.type === kind.type) ?? []
          return children.length ? <section key={kind.type} aria-label={kind.label}>
            <Typography.Title level={5}>{kind.label}（{children.length}）</Typography.Title>
            <div className="data-list">{children.map((item) => itemRow(item, true))}</div>
          </section> : null
        })}
        {!selected.children?.length ? <Empty description={`没有可单独恢复的内容，可直接恢复整个${groupLabel(selected)}。`} /> : null}
      </div> : category ? <div className="trash-plan-detail">
        <Button type="primary" disabled={busy} onClick={() => void onRestoreCategory(category.module)}>恢复{category.label}全部内容</Button>
        <div className="data-list">{category.items.map((item) => itemRow(item))}</div>
      </div> : null}
    </Modal>
  </>
}
