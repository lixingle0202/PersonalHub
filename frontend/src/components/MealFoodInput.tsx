import { useEffect, useState } from 'react'
import { AutoComplete, Button, Input, Typography, type InputProps } from 'antd'
import { apiRequest } from '../api/client'
import './MealFoodInput.css'

type Props = Pick<InputProps, 'id' | 'disabled' | 'aria-describedby' | 'aria-invalid'> & {
  value?: string
  onChange?: (value: string) => void
}

// Newline-separated text keeps old meals and exports compatible, while making
// individual additions/removals visible instead of requiring a separator syntax.
export function MealFoodInput({ value = '', onChange, ...props }: Props) {
  const lines = value.split('\n')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [options, setOptions] = useState<Array<{ value: string; label: string }>>([])
  const [counts, setCounts] = useState<{ foods: number; recipes: number } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void apiRequest<{ items: Array<{ name: string; label: string }>; food_count: number; recipe_count: number }>(
        `/diet/food-references?q=${encodeURIComponent(query.slice(0, 100))}&limit=12`, { signal: controller.signal },
      ).then((result) => {
        if (controller.signal.aborted) return
        setOptions((result.items ?? []).map((item) => ({ value: item.name, label: item.label })))
        if (typeof result.food_count === 'number') setCounts({ foods: result.food_count, recipes: result.recipe_count })
      }).catch(() => { if (!controller.signal.aborted) setOptions([]) })
    }, 200)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [query])
  function change(index: number, text: string) {
    setActive(index); setQuery(text)
    onChange?.(lines.map((line, current) => current === index ? text : line).join('\n'))
  }
  return <div className="meal-food-input">
    {lines.map((line, index) => <div className="meal-food-row" key={index}>
      <AutoComplete value={line} options={active === index ? options : []} disabled={props.disabled}
        onFocus={() => { setActive(index); setQuery(line) }} onChange={(text) => change(index, text)}>
        <Input {...props} id={index === 0 ? props.id : undefined} aria-label={index ? `第${index + 1}项餐食` : undefined}
          placeholder={index ? '例如：西红柿炒鸡蛋0.5份' : '搜索食物，或填写蛋炒饭200g'} />
      </AutoComplete>
      {lines.length > 1 ? <Button disabled={props.disabled} aria-label={`移除第${index + 1}项餐食`}
        onClick={() => onChange?.(lines.filter((_, current) => current !== index).join('\n'))}>移除</Button> : null}
    </div>)}
    <Button disabled={props.disabled || lines.length >= 20} onClick={() => onChange?.(`${value}\n`)}>＋ 添加一道菜或主食</Button>
    {counts ? <Typography.Text type="secondary">已内置 {counts.foods.toLocaleString()} 项食物数据、{counts.recipes} 道常见菜参考配方。
      <a href="https://data.gov.tw/dataset/8543" target="_blank" rel="noreferrer">食物数据来源：食品药物管理署</a>
    </Typography.Text> : null}
  </div>
}
