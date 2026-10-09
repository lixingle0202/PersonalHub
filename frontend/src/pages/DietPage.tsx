import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, Col, DatePicker, Form, Input, InputNumber, Modal, Row, Space, Tabs, Typography, message } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { apiRequest } from '../api/client'
import { ConfirmDangerButton } from '../components/ConfirmDangerButton'
import { calendarRange, DietCalendar, mealTypes, type Meal, type MealType } from '../components/DietCalendar'
import { ErrorPanel, LoadingPanel } from '../components/StatePanels'

type Ingredient = { id?: string; name: string; quantity: number | null; unit: string }
type Dish = { id: string; name: string; instructions: string; nutrition_notes: string; notes: string; ingredients: Ingredient[] }
type Shopping = { id: string; name: string; start_date: string; end_date: string; items: Array<{ id: string; ingredient_name: string; quantity_text: string; is_completed: boolean }> }
type Health = { log_date: string; water_ml: number; weight_kg: number | null; feeling: string }

export function DietPage() {
  const [month, setMonth] = useState(dayjs().startOf('month'))
  const [dishes, setDishes] = useState<Dish[] | null>(null)
  const [meals, setMeals] = useState<Meal[]>([])
  const [shopping, setShopping] = useState<Shopping[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState('')
  const [modal, setModal] = useState<'dish' | 'meal' | 'shopping' | null>(null)
  const [editingMeal, setEditingMeal] = useState<Meal | null>(null)
  const [editingDish, setEditingDish] = useState<Dish | null>(null)
  const [resetting, setResetting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [loadingCalendar, setLoadingCalendar] = useState(false)
  const loadVersion = useRef(0)
  const [form] = Form.useForm()

  const load = useCallback(async () => {
    const version = ++loadVersion.current
    const { start, end } = calendarRange(month)
    setLoadingCalendar(true)
    try {
      const [dishData, mealData, shopData, healthData] = await Promise.all([
        apiRequest<Dish[]>('/diet/dishes'),
        apiRequest<Meal[]>(`/diet/meals?start_date=${start.format('YYYY-MM-DD')}&end_date=${end.format('YYYY-MM-DD')}`),
        apiRequest<Shopping[]>('/diet/shopping-lists'),
        apiRequest<Health>(`/diet/health/${dayjs().format('YYYY-MM-DD')}`),
      ])
      if (version === loadVersion.current) {
        setDishes(dishData); setMeals(mealData); setShopping(shopData); setHealth(healthData); setError('')
      }
    } catch (reason) { if (version === loadVersion.current) setError(reason instanceof Error ? reason.message : '读取失败') }
    finally { if (version === loadVersion.current) setLoadingCalendar(false) }
  }, [month])
  useEffect(() => { void load(); return () => { ++loadVersion.current } }, [load])

  async function submit(values: Record<string, unknown>) {
    setSaving(true)
    try {
      let nextMonth: Dayjs | null = null
      if (modal === 'dish') {
        const ingredients = String(values.ingredients_text ?? '').split('\n').filter(Boolean).map((line) => {
          const [name, quantity, unit] = line.split('|').map((part) => part.trim())
          return { name, quantity: quantity ? Number(quantity) : null, unit: unit ?? '' }
        })
        await apiRequest(editingDish ? `/diet/dishes/${editingDish.id}` : '/diet/dishes', { method: editingDish ? 'PATCH' : 'POST', body: JSON.stringify({ ...values, ingredients, ingredients_text: undefined }) })
        message.success(editingDish ? '菜品已更新' : '菜品已创建')
      } else if (modal === 'meal') {
        const mealDate = (values.meal_date as Dayjs).format('YYYY-MM-DD')
        await apiRequest(editingMeal ? `/diet/meals/${editingMeal.id}` : '/diet/meals', {
          method: editingMeal ? 'PATCH' : 'POST',
          body: JSON.stringify({ ...values, dish_id: values.dish_id || null, meal_date: mealDate, actual_food: editingMeal?.actual_food ?? '' }),
        })
        message.success(editingMeal ? '饮食安排已更新' : '饮食安排已创建')
        if (!dayjs(mealDate).isSame(month, 'month')) nextMonth = dayjs(mealDate).startOf('month')
      } else if (modal === 'shopping') {
        await apiRequest('/diet/shopping-lists/generate', { method: 'POST', body: JSON.stringify({ name: values.name, start_date: month.format('YYYY-MM-DD'), end_date: month.endOf('month').format('YYYY-MM-DD') }) })
      }
      form.resetFields(); setEditingMeal(null); setEditingDish(null); setModal(null)
      if (nextMonth) setMonth(nextMonth)
      else await load()
    } catch (reason) { message.error(reason instanceof Error ? reason.message : '保存失败，请重试') }
    finally { setSaving(false) }
  }

  function openMealEditor(mealDate: Dayjs, mealType: MealType, meal: Meal | null = null) {
    form.resetFields()
    setEditingMeal(meal)
    form.setFieldsValue({
      meal_date: mealDate,
      meal_type: mealType,
      dish_id: meal?.dish_id ?? undefined,
      custom_name: meal?.custom_name ?? '',
    })
    setModal('meal')
  }

  function openDishEditor(dish: Dish) {
    form.resetFields()
    setEditingMeal(null); setEditingDish(dish)
    form.setFieldsValue({ name: dish.name, instructions: dish.instructions, nutrition_notes: dish.nutrition_notes, ingredients_text: dish.ingredients.map((item) => `${item.name} | ${item.quantity ?? ''} | ${item.unit}`).join('\n') })
    setModal('dish')
  }

  function openSimpleModal(next: 'dish' | 'shopping') {
    form.resetFields()
    setEditingMeal(null)
    setEditingDish(null)
    setModal(next)
  }

  function closeModal() {
    form.resetFields()
    setDeleteConfirmOpen(false)
    setDeleteError('')
    setEditingMeal(null)
    setEditingDish(null)
    setModal(null)
  }
  async function deleteMeal() {
    if (!editingMeal || deleting || saving) return
    setDeleting(true)
    setDeleteError('')
    try {
      await apiRequest(`/diet/meals/${editingMeal.id}`, { method: 'DELETE' })
      closeModal()
      await load()
      message.success('饮食安排已删除，其他模块已同步移除')
    } catch (reason) { setDeleteError(reason instanceof Error ? reason.message : '删除失败，请重试') }
    finally { setDeleting(false) }
  }
  async function saveHealth(values: { water_ml: number; weight_kg?: number; feeling?: string }) {
    await apiRequest(`/diet/health/${dayjs().format('YYYY-MM-DD')}`, { method: 'PUT', body: JSON.stringify(values) })
    message.success('今日记录已保存'); await load()
  }
  async function toggleShopping(id: string, checked: boolean) {
    await apiRequest(`/diet/shopping-items/${id}`, { method: 'PATCH', body: JSON.stringify({ is_completed: checked }) }); await load()
  }
  async function resetAllPlans() {
    setResetting(true)
    try {
      await apiRequest('/diet/reset', { method: 'POST' })
      await load()
      message.success('全部饮食计划已清零')
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '清零失败，请重试')
    } finally {
      setResetting(false)
    }
  }

  if (error) return <ErrorPanel message={error} onRetry={() => void load()} />
  if (!dishes || !health) return <LoadingPanel />
  return <div className="page-stack">
    <Tabs items={[
      { key: 'calendar', label: '饮食日历', children: <><div className="page-actions diet-calendar-intro"><div><Typography.Title level={4}>饮食日历</Typography.Title><Typography.Text type="secondary">按天查看计划餐食和实际饮食，点击餐食卡片可修改或删除</Typography.Text></div><Space><ConfirmDangerButton label="清零全部饮食计划" title="确认清零全部饮食计划？" description="所有日期的早、午、晚餐和加餐安排都会取消并从页面隐藏，可在回收站中恢复。" disabled={resetting} onConfirm={resetAllPlans} /><Button type="primary" onClick={() => openMealEditor(dayjs(), 'dinner')}>安排一餐</Button></Space></div><DietCalendar month={month} meals={meals} loading={loadingCalendar} onMonthChange={setMonth} onEdit={(date, type, meal) => openMealEditor(date, type, meal)} /></> },
      { key: 'dishes', label: '常用菜品', children: <><div className="tab-actions"><Button type="primary" onClick={() => openSimpleModal('dish')}>新增菜品</Button></div><Row gutter={[12, 12]}>{dishes.map((dish) => <Col span={8} key={dish.id}><Card title={dish.name} extra={<Button aria-label={`修改菜品 ${dish.name}`} onClick={() => openDishEditor(dish)}>修改</Button>}><p>{dish.instructions || '暂无做法'}</p><Typography.Text type="secondary">{dish.ingredients.map((item) => item.name).join('、') || '暂无食材'}</Typography.Text></Card></Col>)}</Row></> },
      { key: 'shopping', label: '购物清单', children: <><div className="tab-actions"><Button type="primary" onClick={() => openSimpleModal('shopping')}>按当前月份饮食生成</Button></div>{shopping.map((list) => <Card title={`${list.name} · ${list.start_date}—${list.end_date}`} key={list.id}>{list.items.map((item) => <div className="shopping-row" key={item.id}><Checkbox checked={item.is_completed} onChange={(event) => void toggleShopping(item.id, event.target.checked)}>{item.ingredient_name}</Checkbox><span>{item.quantity_text}</span></div>)}</Card>)}</> },
      { key: 'daily', label: '每日记录', children: <Card title="今天"><Form layout="vertical" initialValues={health} onFinish={(values) => void saveHealth(values)}><Row gutter={12}><Col span={8}><Form.Item name="water_ml" label="饮水量（ml）"><InputNumber min={0} /></Form.Item></Col><Col span={8}><Form.Item name="weight_kg" label="体重（kg）"><InputNumber min={1} step={0.1} /></Form.Item></Col></Row><Form.Item name="feeling" label="今日感受"><Input.TextArea /></Form.Item><Button type="primary" htmlType="submit">保存记录</Button></Form></Card> },
    ]} />
    <Modal forceRender title={modal === 'dish' ? editingDish ? '修改菜品' : '新增菜品' : modal === 'meal' ? editingMeal ? '修改饮食安排' : '安排一餐' : '生成购物清单'} open={Boolean(modal)} closable={{ disabled: saving || deleting }} keyboard={!saving && !deleting} mask={{ closable: !saving && !deleting }} onCancel={() => { if (!saving && !deleting) closeModal() }} footer={<div className="diet-editor-footer"><div>{editingMeal ? <Button aria-label="删除这餐" danger disabled={saving || deleting} onClick={() => { setDeleteError(''); setDeleteConfirmOpen(true) }}>删除这餐</Button> : null}</div><Space><Button aria-label="取消" disabled={saving || deleting} onClick={closeModal}>取消</Button><Button aria-label={editingMeal || editingDish ? '保存修改' : '创建'} type="primary" loading={saving} disabled={deleting} onClick={() => form.submit()}>{editingMeal || editingDish ? '保存修改' : '创建'}</Button></Space></div>}>
      <Form form={form} layout="vertical" onFinish={(values) => void submit(values)}>
        {modal === 'dish' ? <><Form.Item name="name" label="菜品名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="instructions" label="简单做法"><Input.TextArea /></Form.Item><Form.Item name="ingredients_text" label="食材（每行：名称 | 数量 | 单位）"><Input.TextArea rows={5} placeholder={'鸡蛋 | 2 | 个\n番茄 | 2 | 个'} /></Form.Item><Form.Item name="nutrition_notes" label="营养备注"><Input.TextArea /></Form.Item></> : null}
        {modal === 'meal' ? <><Form.Item name="meal_date" label="日期" rules={[{ required: true }]}><DatePicker /></Form.Item><Form.Item name="meal_type" label="餐次" rules={[{ required: true }]}><select className="native-form-select">{mealTypes.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Form.Item><Form.Item name="dish_id" label="选择菜品"><select className="native-form-select"><option value="">不选择常用菜品</option>{dishes.map((dish) => <option value={dish.id} key={dish.id}>{dish.name}</option>)}</select></Form.Item><Form.Item name="custom_name" label="或填写其他餐食"><Input /></Form.Item></> : null}
        {modal === 'shopping' ? <Form.Item name="name" label="清单名称" initialValue="本月采购" rules={[{ required: true }]}><Input /></Form.Item> : null}
      </Form>
    </Modal>
    <Modal title="确认删除这餐？" centered width={440} open={deleteConfirmOpen && Boolean(editingMeal)} onOk={() => void deleteMeal()} onCancel={() => { if (!deleting) { setDeleteConfirmOpen(false); setDeleteError('') } }} okText="确认" cancelText="取消" confirmLoading={deleting} okButtonProps={{ danger: true, disabled: saving || deleting }} cancelButtonProps={{ disabled: deleting }} closable={!deleting} keyboard={!deleting} mask={{ closable: !deleting }}>
      <Typography.Paragraph>这条饮食安排将从饮食日历、首页、今日计划和搜索中移除，可在回收站恢复。</Typography.Paragraph>
      {deleteError ? <Alert type="error" showIcon title={deleteError} /> : null}
    </Modal>
  </div>
}
