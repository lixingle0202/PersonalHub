import { useEffect, useState } from 'react'
import { Alert, Button, Form, Typography } from 'antd'
import { apiRequest } from '../api/client'

type Estimate = { display_kcal: number | null; calorie_source: string; calorie_explanation: string }

export function CaloriePreview() {
  const form = Form.useFormInstance()
  const dishIds = Form.useWatch('dish_ids', form) as string[] | undefined
  const customName = Form.useWatch('custom_name', form) as string | undefined
  const servings = Form.useWatch('servings', form) as number | null | undefined
  const manual = Form.useWatch('estimated_kcal', form) as number | null | undefined
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [retry, setRetry] = useState(0)
  const body = JSON.stringify({ dish_ids: dishIds ?? [], custom_name: customName ?? '', servings: servings ?? 1, estimated_kcal: manual ?? null })
  const hasFood = Boolean(dishIds?.length || customName?.trim())

  useEffect(() => {
    setEstimate(null)
    setError('')
    if (!hasFood) { setLoading(false); return }
    setLoading(true)
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void apiRequest<Estimate>('/diet/calories/estimate', { method: 'POST', body, signal: controller.signal })
        .then((value) => { if (!controller.signal.aborted) setEstimate(value) })
        .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '暂时无法估算热量') })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 300)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [body, hasFood, retry])

  if (!hasFood) return <Typography.Paragraph type="secondary">选择菜品或填写餐食后，会显示热量估算和食材依据。</Typography.Paragraph>
  if (error) return <Alert type="warning" title="热量暂未估算" description={<>{error} <Button size="small" onClick={() => setRetry((value) => value + 1)}>重试估算</Button></>} />
  if (loading || !estimate) return <Typography.Paragraph role="status" type="secondary">正在估算这餐热量…</Typography.Paragraph>
  return <Alert className="calorie-preview" type={estimate.display_kcal == null ? 'warning' : 'info'} showIcon
    title={estimate.display_kcal == null ? '热量待补充' : `本餐约 ${estimate.display_kcal} kcal · ${estimate.calorie_source}`}
    description={<><Typography.Paragraph>{estimate.calorie_explanation}</Typography.Paragraph><Typography.Text type="secondary">可在“常用菜品”中修改实际食材、用油量和配方份数；已有餐食会随配方重新计算。参考配方是示例，不能代替实际称量。</Typography.Text></>}
  />
}
