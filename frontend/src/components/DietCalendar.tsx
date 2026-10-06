import { useMemo, useState } from 'react'
import { Button, DatePicker, Space, Typography } from 'antd'
import { CalendarOutlined, LeftOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'

export const mealTypes = [['breakfast', '早餐'], ['lunch', '午餐'], ['dinner', '晚餐'], ['snack', '加餐']] as const
export type MealType = typeof mealTypes[number][0]
export type Meal = {
  id: string; meal_date: string; meal_type: MealType; dish_id: string | null
  custom_name: string; dish_name: string; actual_food: string; status: string | null
}

export function calendarRange(month: Dayjs) {
  const first = month.startOf('month')
  const last = month.endOf('month').startOf('day')
  return {
    start: first.subtract((first.day() + 6) % 7, 'day'),
    end: last.add(6 - (last.day() + 6) % 7, 'day'),
  }
}

export function DietCalendar({ month, meals, loading, onMonthChange, onEdit }: {
  month: Dayjs
  meals: Meal[]
  loading: boolean
  onMonthChange: (month: Dayjs) => void
  onEdit: (date: Dayjs, type: MealType, meal?: Meal) => void
}) {
  const [expandedDates, setExpandedDates] = useState<string[]>([])
  const { start, end } = calendarRange(month)
  const days = Array.from({ length: end.diff(start, 'day') + 1 }, (_, index) => start.add(index, 'day'))
  const weeks = Array.from({ length: days.length / 7 }, (_, index) => days.slice(index * 7, index * 7 + 7))
  const byDate = useMemo(() => {
    const grouped = new Map<string, Meal[]>()
    for (const meal of meals) grouped.set(meal.meal_date, [...(grouped.get(meal.meal_date) ?? []), meal])
    for (const entries of grouped.values()) entries.sort((a, b) => mealTypes.findIndex(([type]) => type === a.meal_type) - mealTypes.findIndex(([type]) => type === b.meal_type))
    return grouped
  }, [meals])

  return <section className="diet-calendar" aria-label="饮食日历" aria-busy={loading}>
    <div className="diet-calendar-toolbar">
      <Space size="middle"><CalendarOutlined /><strong>{month.format('YYYY年M月')}</strong><DatePicker picker="month" value={month} allowClear={false} aria-label="选择月份" onChange={(value) => { if (value) onMonthChange(value.startOf('month')) }} /></Space>
      <Space><Button aria-label="上一月" icon={<LeftOutlined />} onClick={() => onMonthChange(month.subtract(1, 'month'))} /><Button onClick={() => onMonthChange(dayjs().startOf('month'))}>回到今天</Button><Button aria-label="下一月" icon={<RightOutlined />} onClick={() => onMonthChange(month.add(1, 'month'))} /></Space>
    </div>
    <div className="diet-calendar-scroll">
      <table aria-label="饮食月历">
        <thead><tr>{['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{weeks.map((week) => <tr key={week[0].format('YYYY-MM-DD')}>{week.map((day) => {
          const date = day.format('YYYY-MM-DD')
          const today = day.isSame(dayjs(), 'day')
          const entries = byDate.get(date) ?? []
          const expanded = expandedDates.includes(date)
          return <td key={date} aria-label={date} aria-current={today ? 'date' : undefined} className={`${day.isSame(month, 'month') ? '' : 'calendar-other-month'} ${today ? 'calendar-today' : ''}`}>
            <div className="calendar-day-heading"><button type="button" className="calendar-add" aria-label={`为 ${date} 添加饮食安排`} onClick={() => onEdit(day, 'dinner')}><PlusOutlined /></button><span className="calendar-day-number">{day.date()}</span></div>
            <div className="calendar-meals">{(expanded ? entries : entries.slice(0, 2)).map((meal) => <button type="button" className={`calendar-meal ${meal.actual_food ? 'calendar-meal-actual' : ''}`} key={meal.id} aria-label={`修改 ${date} ${mealTypes.find(([type]) => type === meal.meal_type)?.[1]}`} onClick={() => onEdit(day, meal.meal_type, meal)}>
              <strong>{meal.actual_food ? '实际' : '计划'} · {mealTypes.find(([type]) => type === meal.meal_type)?.[1]}</strong>
              <span>{meal.dish_name}</span>
              {meal.actual_food ? <span className="calendar-actual-food">实际：{meal.actual_food}</span> : null}
            </button>)}</div>
            {entries.length > 2 ? <button type="button" className="calendar-more" aria-expanded={expanded} onClick={() => setExpandedDates((values) => expanded ? values.filter((value) => value !== date) : [...values, date])}>{expanded ? '收起' : `另有 ${entries.length - 2} 餐`}</button> : null}
            {!entries.length ? <div className="calendar-empty"><Typography.Text type="secondary">未安排</Typography.Text><div>{mealTypes.map(([type, label]) => <button type="button" key={type} aria-label={`安排 ${date} ${label}`} onClick={() => onEdit(day, type)}>{label}</button>)}</div></div> : null}
          </td>
        })}</tr>)}</tbody>
      </table>
    </div>
  </section>
}
