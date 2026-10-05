import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Card, Checkbox, Col, DatePicker, Form, Input, InputNumber, Modal, Row, Select, Space, Tabs, Typography, message } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { apiRequest } from '../api/client'
import { ErrorPanel, LoadingPanel } from '../components/StatePanels'

type Ingredient = { id?: string; name: string; quantity: number | null; unit: string }
type Dish = { id: string; name: string; instructions: string; nutrition_notes: string; notes: string; ingredients: Ingredient[] }
type Meal = { id: string; meal_date: string; meal_type: string; dish_id: string | null; custom_name: string; dish_name: string; actual_food: string; status: string }
type Shopping = { id: string; name: string; start_date: string; end_date: string; items: Array<{ id: string; ingredient_name: string; quantity_text: string; is_completed: boolean }> }
type Health = { log_date: string; water_ml: number; weight_kg: number | null; feeling: string }

const mealTypes = [['breakfast', '早餐'], ['lunch', '午餐'], ['dinner', '晚餐'], ['snack', '加餐']] as const

export function DietPage() {
  const [weekStart, setWeekStart] = useState(dayjs().startOf('week').add(1, 'day'))
  const [dishes, setDishes] = useState<Dish[] | null>(null)
  const [meals, setMeals] = useState<Meal[]>([])
  const [shopping, setShopping] = useState<Shopping[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState('')
  const [modal, setModal] = useState<'dish' | 'meal' | 'shopping' | null>(null)
  const [editingMeal, setEditingMeal] = useState<Meal | null>(null)
  const [form] = Form.useForm()
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => weekStart.add(index, 'day')), [weekStart])

  const load = useCallback(async () => {
    try {
      const [dishData, mealData, shopData, healthData] = await Promise.all([
        apiRequest<Dish[]>('/diet/dishes'),
        apiRequest<Meal[]>(`/diet/meals?start_date=${weekStart.format('YYYY-MM-DD')}&end_date=${weekStart.add(6, 'day').format('YYYY-MM-DD')}`),
        apiRequest<Shopping[]>('/diet/shopping-lists'),
        apiRequest<Health>(`/diet/health/${dayjs().format('YYYY-MM-DD')}`),
      ])
      setDishes(dishData); setMeals(mealData); setShopping(shopData); setHealth(healthData); setError('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '读取失败') }
  }, [weekStart])
  useEffect(() => { void load() }, [load])

  async function submit(values: Record<string, unknown>) {
    if (modal === 'dish') {
      const ingredients = String(values.ingredients_text ?? '').split('\n').filter(Boolean).map((line) => {
        const [name, quantity, unit] = line.split('|').map((part) => part.trim())
        return { name, quantity: quantity ? Number(quantity) : null, unit: unit ?? '' }
      })
      await apiRequest('/diet/dishes', { method: 'POST', body: JSON.stringify({ ...values, ingredients, ingredients_text: undefined }) })
    } else if (modal === 'meal') {
      const mealDate = (values.meal_date as Dayjs).format('YYYY-MM-DD')
      await apiRequest(editingMeal ? `/diet/meals/${editingMeal.id}` : '/diet/meals', {
        method: editingMeal ? 'PATCH' : 'POST',
        body: JSON.stringify({ ...values, meal_date: mealDate }),
      })
      message.success(editingMeal ? '饮食安排已更新' : '饮食安排已创建')
    } else if (modal === 'shopping') {
      await apiRequest('/diet/shopping-lists/generate', { method: 'POST', body: JSON.stringify({ name: values.name, start_date: weekStart.format('YYYY-MM-DD'), end_date: weekStart.add(6, 'day').format('YYYY-MM-DD') }) })
    }
    form.resetFields(); setEditingMeal(null); setModal(null); await load()
  }

  function openMealEditor(mealDate: Dayjs, mealType: typeof mealTypes[number][0], meal: Meal | null = null) {
    form.resetFields()
    setEditingMeal(meal)
    form.setFieldsValue({
      meal_date: mealDate,
      meal_type: mealType,
      dish_id: meal?.dish_id ?? undefined,
      custom_name: meal?.custom_name ?? '',
      actual_food: meal?.actual_food ?? '',
    })
    setModal('meal')
  }

  function openSimpleModal(next: 'dish' | 'shopping') {
    form.resetFields()
    setEditingMeal(null)
    setModal(next)
  }

  function closeModal() {
    form.resetFields()
    setEditingMeal(null)
    setModal(null)
  }
  async function saveHealth(values: { water_ml: number; weight_kg?: number; feeling?: string }) {
    await apiRequest(`/diet/health/${dayjs().format('YYYY-MM-DD')}`, { method: 'PUT', body: JSON.stringify(values) })
    message.success('今日记录已保存'); await load()
  }
  async function toggleShopping(id: string, checked: boolean) {
    await apiRequest(`/diet/shopping-items/${id}`, { method: 'PATCH', body: JSON.stringify({ is_completed: checked }) }); await load()
  }

  if (error) return <ErrorPanel message={error} onRetry={() => void load()} />
  if (!dishes || !health) return <LoadingPanel />
  return <div className="page-stack">
    <Tabs items={[
      { key: 'week', label: '每周饮食', children: <><div className="page-actions"><Space><Button onClick={() => setWeekStart((value) => value.subtract(7, 'day'))}>上一周</Button><strong>{weekStart.format('MM月DD日')}—{weekStart.add(6, 'day').format('MM月DD日')}</strong><Button onClick={() => setWeekStart((value) => value.add(7, 'day'))}>下一周</Button></Space><Button type="primary" onClick={() => openMealEditor(dayjs(), 'dinner')}>安排一餐</Button></div><div className="meal-week">{days.map((day) => <section key={day.format('YYYY-MM-DD')}><header>{day.format('周dd MM/DD')}</header>{mealTypes.map(([value, label]) => { const dateText = day.format('YYYY-MM-DD'); const meal = meals.find((item) => item.meal_date === dateText && item.meal_type === value); const open = () => openMealEditor(day, value, meal ?? null); return <Card className="meal-slot" role="button" tabIndex={0} aria-label={`${meal ? '修改' : '安排'} ${dateText} ${label}`} hoverable size="small" key={value} onClick={open} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open() } }}><Typography.Text type="secondary">{label}</Typography.Text><div>{meal?.dish_name || '未安排'}</div></Card> })}</section>)}</div></> },
      { key: 'dishes', label: '常用菜品', children: <><div className="tab-actions"><Button type="primary" onClick={() => openSimpleModal('dish')}>新增菜品</Button></div><Row gutter={[12, 12]}>{dishes.map((dish) => <Col span={8} key={dish.id}><Card title={dish.name}><p>{dish.instructions || '暂无做法'}</p><Typography.Text type="secondary">{dish.ingredients.map((item) => item.name).join('、') || '暂无食材'}</Typography.Text></Card></Col>)}</Row></> },
      { key: 'shopping', label: '购物清单', children: <><div className="tab-actions"><Button type="primary" onClick={() => openSimpleModal('shopping')}>按本周饮食生成</Button></div>{shopping.map((list) => <Card title={`${list.name} · ${list.start_date}—${list.end_date}`} key={list.id}>{list.items.map((item) => <div className="shopping-row" key={item.id}><Checkbox checked={item.is_completed} onChange={(event) => void toggleShopping(item.id, event.target.checked)}>{item.ingredient_name}</Checkbox><span>{item.quantity_text}</span></div>)}</Card>)}</> },
      { key: 'daily', label: '每日记录', children: <Card title="今天"><Form layout="vertical" initialValues={health} onFinish={(values) => void saveHealth(values)}><Row gutter={12}><Col span={8}><Form.Item name="water_ml" label="饮水量（ml）"><InputNumber min={0} /></Form.Item></Col><Col span={8}><Form.Item name="weight_kg" label="体重（kg）"><InputNumber min={1} step={0.1} /></Form.Item></Col></Row><Form.Item name="feeling" label="今日感受"><Input.TextArea /></Form.Item><Button type="primary" htmlType="submit">保存记录</Button></Form></Card> },
    ]} />
    <Modal forceRender title={modal === 'dish' ? '新增菜品' : modal === 'meal' ? editingMeal ? '修改饮食安排' : '安排一餐' : '生成购物清单'} open={Boolean(modal)} onCancel={closeModal} onOk={() => form.submit()} okText={editingMeal ? '保存修改' : '创建'}>
      <Form form={form} layout="vertical" onFinish={(values) => void submit(values)}>
        {modal === 'dish' ? <><Form.Item name="name" label="菜品名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="instructions" label="简单做法"><Input.TextArea /></Form.Item><Form.Item name="ingredients_text" label="食材（每行：名称 | 数量 | 单位）"><Input.TextArea rows={5} placeholder={'鸡蛋 | 2 | 个\n番茄 | 2 | 个'} /></Form.Item><Form.Item name="nutrition_notes" label="营养备注"><Input.TextArea /></Form.Item></> : null}
        {modal === 'meal' ? <><Form.Item name="meal_date" label="日期" rules={[{ required: true }]}><DatePicker /></Form.Item><Form.Item name="meal_type" label="餐次" rules={[{ required: true }]}><Select options={mealTypes.map(([value, label]) => ({ value, label }))} /></Form.Item><Form.Item name="dish_id" label="选择菜品"><Select allowClear options={dishes.map((dish) => ({ value: dish.id, label: dish.name }))} /></Form.Item><Form.Item name="custom_name" label="或填写其他餐食"><Input /></Form.Item><Form.Item name="actual_food" label="实际饮食（可选）"><Input /></Form.Item></> : null}
        {modal === 'shopping' ? <Form.Item name="name" label="清单名称" initialValue="本周采购" rules={[{ required: true }]}><Input /></Form.Item> : null}
      </Form>
    </Modal>
  </div>
}
