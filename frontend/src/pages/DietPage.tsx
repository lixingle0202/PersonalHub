import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, Col, DatePicker, Form, Input, InputNumber, Modal, Row, Space, Tabs, Typography, message } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { apiRequest } from '../api/client'
import { ConfirmDangerButton } from '../components/ConfirmDangerButton'
import { DietTemplates } from '../components/DietTemplates'
import { calendarRange, DietCalendar, mealTypes, type Meal, type MealType } from '../components/DietCalendar'
import { ErrorPanel, LoadingPanel } from '../components/StatePanels'
import '../components/DishMultiSelect.css'

type Ingredient = { id?: string; name: string; quantity: number | null; unit: string }
type Dish = { id: string; name: string; instructions: string; nutrition_notes: string; notes: string; estimated_kcal?: number | null; ingredients: Ingredient[] }
type DietProfile = { height_cm: number | null; weight_kg: number | null }
type Shopping = { id: string; name: string; start_date: string; end_date: string; items: Array<{ id: string; ingredient_name: string; quantity_text: string; is_completed: boolean }> }
type Health = { log_date: string; water_ml: number; weight_kg: number | null; feeling: string }

function DishMultiSelect({ dishes, value = [], onChange }: {
  dishes: Dish[]; value?: string[]; onChange?: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const names = dishes.filter((dish) => value.includes(dish.id)).map((dish) => dish.name)
  return <div className="dish-multi-select">
    <button type="button" className="native-form-select dish-multi-trigger" aria-label="选择菜品" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span>{names.length ? names.join('、') : '不选择常用菜品'}</span><span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
    </button>
    {open ? <div className="dish-multi-options" role="group" aria-label="常用菜品">
      {dishes.length ? dishes.map((dish) => <label key={dish.id}><input type="checkbox" checked={value.includes(dish.id)} onChange={(event) => onChange?.(event.target.checked ? [...value, dish.id] : value.filter((id) => id !== dish.id))} />{dish.name}</label>) : <span>暂无常用菜品，可先在“常用菜品”中添加</span>}
    </div> : null}
  </div>
}

export function DietPage() {
  const [month, setMonth] = useState(dayjs().startOf('month'))
  const [dishes, setDishes] = useState<Dish[] | null>(null)
  const [meals, setMeals] = useState<Meal[]>([])
  const [shopping, setShopping] = useState<Shopping[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [profile, setProfile] = useState<DietProfile | null>(null)
  const [error, setError] = useState('')
  const [modal, setModal] = useState<'dish' | 'meal' | 'shopping' | 'shoppingList' | 'shoppingItem' | null>(null)
  const [editingMeal, setEditingMeal] = useState<Meal | null>(null)
  const [editingDish, setEditingDish] = useState<Dish | null>(null)
  const [shoppingTarget, setShoppingTarget] = useState<{ listId: string; itemId?: string } | null>(null)
  const [resetting, setResetting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [profileSaving, setProfileSaving] = useState(false)
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
      const [dishData, mealData, shopData, healthData, profileData] = await Promise.all([
        apiRequest<Dish[]>('/diet/dishes'),
        apiRequest<Meal[]>(`/diet/meals?start_date=${start.format('YYYY-MM-DD')}&end_date=${end.format('YYYY-MM-DD')}`),
        apiRequest<Shopping[]>('/diet/shopping-lists'),
        apiRequest<Health>(`/diet/health/${dayjs().format('YYYY-MM-DD')}`),
        apiRequest<DietProfile>('/diet/profile'),
      ])
      if (version === loadVersion.current) {
        setDishes(dishData); setMeals(mealData); setShopping(shopData); setHealth(healthData); setProfile(profileData); setError('')
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
        const dishIds = (values.dish_ids as string[] | undefined) ?? []
        await apiRequest(editingMeal ? `/diet/meals/${editingMeal.id}` : '/diet/meals', {
          method: editingMeal ? 'PATCH' : 'POST',
          body: JSON.stringify({ ...values, dish_ids: dishIds, dish_id: dishIds[0] ?? null, meal_date: mealDate, actual_food: editingMeal?.actual_food ?? '' }),
        })
        message.success(editingMeal ? '饮食安排已更新' : '饮食安排已创建')
        if (!dayjs(mealDate).isSame(month, 'month')) nextMonth = dayjs(mealDate).startOf('month')
      } else if (modal === 'shopping') {
        await apiRequest('/diet/shopping-lists/generate', { method: 'POST', body: JSON.stringify({ name: values.name, start_date: month.format('YYYY-MM-DD'), end_date: month.endOf('month').format('YYYY-MM-DD') }) })
      } else if (modal === 'shoppingList') {
        await apiRequest('/diet/shopping-lists', { method: 'POST', body: JSON.stringify({ name: values.name, start_date: month.format('YYYY-MM-DD'), end_date: month.endOf('month').format('YYYY-MM-DD') }) })
      } else if (modal === 'shoppingItem' && shoppingTarget) {
        await apiRequest(shoppingTarget.itemId ? `/diet/shopping-items/${shoppingTarget.itemId}` : `/diet/shopping-lists/${shoppingTarget.listId}/items`, {
          method: shoppingTarget.itemId ? 'PATCH' : 'POST',
          body: JSON.stringify({ ingredient_name: values.ingredient_name, quantity_text: values.quantity_text ?? '按需' }),
        })
      }
      form.resetFields(); setEditingMeal(null); setEditingDish(null); setShoppingTarget(null); setModal(null)
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
      dish_ids: meal?.dish_ids ?? (meal?.dish_id ? [meal.dish_id] : []),
      custom_name: meal?.custom_name ?? '',
      estimated_kcal: meal?.estimated_kcal ?? null,
    })
    setModal('meal')
  }

  function openDishEditor(dish: Dish) {
    form.resetFields()
    setEditingMeal(null); setEditingDish(dish)
    form.setFieldsValue({ name: dish.name, instructions: dish.instructions, nutrition_notes: dish.nutrition_notes, estimated_kcal: dish.estimated_kcal, ingredients_text: dish.ingredients.map((item) => `${item.name} | ${item.quantity ?? ''} | ${item.unit}`).join('\n') })
    setModal('dish')
  }

  function openSimpleModal(next: 'dish' | 'shopping' | 'shoppingList') {
    form.resetFields()
    setEditingMeal(null)
    setEditingDish(null)
    setModal(next)
  }

  function openShoppingItem(listId: string, item?: Shopping['items'][number]) {
    form.resetFields()
    setShoppingTarget({ listId, itemId: item?.id })
    form.setFieldsValue({ ingredient_name: item?.ingredient_name ?? '', quantity_text: item?.quantity_text ?? '按需' })
    setModal('shoppingItem')
  }

  function closeModal() {
    form.resetFields()
    setDeleteConfirmOpen(false)
    setDeleteError('')
    setEditingMeal(null)
    setEditingDish(null)
    setShoppingTarget(null)
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
  async function saveProfile(values: DietProfile) {
    setProfileSaving(true)
    try {
      const updated = await apiRequest<DietProfile>('/diet/profile', { method: 'PUT', body: JSON.stringify(values) })
      setProfile(updated); message.success('身体资料已保存')
    } catch (reason) { message.error(reason instanceof Error ? reason.message : '保存身体资料失败') }
    finally { setProfileSaving(false) }
  }
  async function toggleShopping(id: string, checked: boolean) {
    await apiRequest(`/diet/shopping-items/${id}`, { method: 'PATCH', body: JSON.stringify({ is_completed: checked }) }); await load()
  }
  async function deleteShoppingItem(id: string) {
    try {
      await apiRequest(`/diet/shopping-items/${id}`, { method: 'DELETE' }); await load()
    } catch (reason) { message.error(reason instanceof Error ? reason.message : '删除购物项目失败') }
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
    <Card title="个人身体资料与热量估算"><Form layout="inline" initialValues={profile ?? {}} onFinish={(values) => void saveProfile(values)}><Form.Item name="height_cm" label="身高（cm）" rules={[{ required: true }]}><InputNumber min={80} max={250} step={0.1} /></Form.Item><Form.Item name="weight_kg" label="体重（kg）" rules={[{ required: true }]}><InputNumber min={20} max={400} step={0.1} /></Form.Item><Button type="primary" htmlType="submit" loading={profileSaving}>保存身体资料</Button></Form><Typography.Text type="secondary">单餐热量按菜品食材和份量粗估；身高体重仅保存为个人资料，不用于推算食物热量。可在每餐手动调整。</Typography.Text></Card>
    <Tabs items={[
      { key: 'calendar', label: '饮食日历', children: <><div className="page-actions diet-calendar-intro"><div><Typography.Title level={4}>饮食日历</Typography.Title><Typography.Text type="secondary">按天查看餐食及估算热量，点击卡片可修改或删除</Typography.Text></div><Space><ConfirmDangerButton label="清零全部饮食计划" title="确认清零全部饮食计划？" description="所有日期的早、午、晚餐和加餐安排都会取消并从页面隐藏，可在回收站中恢复。" disabled={resetting} onConfirm={resetAllPlans} /><Button type="primary" onClick={() => openMealEditor(dayjs(), 'dinner')}>安排一餐</Button></Space></div><DietCalendar month={month} meals={meals} loading={loadingCalendar} onMonthChange={setMonth} onEdit={(date, type, meal) => openMealEditor(date, type, meal)} /></> },
      { key: 'dishes', label: '常用菜品', children: <><div className="tab-actions"><Button type="primary" onClick={() => openSimpleModal('dish')}>新增菜品</Button></div><Row gutter={[12, 12]}>{dishes.map((dish) => <Col span={8} key={dish.id}><Card title={dish.name} extra={<Button aria-label={`修改菜品 ${dish.name}`} onClick={() => openDishEditor(dish)}>修改</Button>}><p>{dish.instructions || '暂无做法'}</p><Typography.Text type="secondary">{dish.ingredients.map((item) => item.name).join('、') || '暂无食材'}</Typography.Text></Card></Col>)}</Row></> },
      { key: 'templates', label: '饮食模板', children: <DietTemplates onImported={async (startDate) => { if (!startDate.isSame(month, 'month')) setMonth(startDate.startOf('month')); else await load() }} /> },
      { key: 'shopping', label: '购物清单', children: <><div className="tab-actions"><Space><Button type="primary" onClick={() => openSimpleModal('shopping')}>按当前月份饮食生成</Button><Button onClick={() => openSimpleModal('shoppingList')}>新建空清单</Button></Space></div>{shopping.map((list) => <Card title={`${list.name} · ${list.start_date}—${list.end_date}`} extra={<Button onClick={() => openShoppingItem(list.id)}>手动添加物品</Button>} key={list.id}>{list.items.length ? list.items.map((item) => <div className="shopping-row" key={item.id}><Checkbox checked={item.is_completed} onChange={(event) => void toggleShopping(item.id, event.target.checked)}>{item.ingredient_name}</Checkbox><span>{item.quantity_text}</span><Button aria-label={`修改购物项目 ${item.ingredient_name}`} onClick={() => openShoppingItem(list.id, item)}>修改</Button><ConfirmDangerButton label={`删除购物项目 ${item.ingredient_name}`} title="删除购物项目？" description="此物品会从这份清单移除。" onConfirm={() => deleteShoppingItem(item.id)} /></div>) : <Typography.Text type="secondary">清单暂无物品，可手动添加。</Typography.Text>}</Card>)}</> },
      { key: 'daily', label: '每日记录', children: <Card title="今天"><Form layout="vertical" initialValues={health} onFinish={(values) => void saveHealth(values)}><Row gutter={12}><Col span={8}><Form.Item name="water_ml" label="饮水量（ml）"><InputNumber min={0} /></Form.Item></Col><Col span={8}><Form.Item name="weight_kg" label="体重（kg）"><InputNumber min={1} step={0.1} /></Form.Item></Col></Row><Form.Item name="feeling" label="今日感受"><Input.TextArea /></Form.Item><Button type="primary" htmlType="submit">保存记录</Button></Form></Card> },
    ]} />
    <Modal forceRender title={modal === 'dish' ? editingDish ? '修改菜品' : '新增菜品' : modal === 'meal' ? editingMeal ? '修改饮食安排' : '安排一餐' : modal === 'shoppingItem' ? shoppingTarget?.itemId ? '修改购物项目' : '手动添加物品' : modal === 'shoppingList' ? '新建空清单' : '生成购物清单'} open={Boolean(modal)} closable={{ disabled: saving || deleting }} keyboard={!saving && !deleting} mask={{ closable: !saving && !deleting }} onCancel={() => { if (!saving && !deleting) closeModal() }} footer={<div className="diet-editor-footer"><div>{editingMeal ? <Button aria-label="删除这餐" danger disabled={saving || deleting} onClick={() => { setDeleteError(''); setDeleteConfirmOpen(true) }}>删除这餐</Button> : null}</div><Space><Button aria-label="取消" disabled={saving || deleting} onClick={closeModal}>取消</Button><Button aria-label={editingMeal || editingDish || shoppingTarget?.itemId ? '保存修改' : '创建'} type="primary" loading={saving} disabled={deleting} onClick={() => form.submit()}>{editingMeal || editingDish || shoppingTarget?.itemId ? '保存修改' : '创建'}</Button></Space></div>}>
      <Form form={form} layout="vertical" onFinish={(values) => void submit(values)}>
        {modal === 'dish' ? <><Form.Item name="name" label="菜品名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="instructions" label="简单做法"><Input.TextArea /></Form.Item><Form.Item name="ingredients_text" label="食材（每行：名称 | 数量 | 单位）"><Input.TextArea rows={5} placeholder={'鸡蛋 | 2 | 个\n番茄 | 2 | 个'} /></Form.Item><Form.Item name="estimated_kcal" label="每份热量（kcal，可选）"><InputNumber min={0} max={10000} /></Form.Item><Form.Item name="nutrition_notes" label="营养备注"><Input.TextArea /></Form.Item></> : null}
        {modal === 'meal' ? <><Form.Item name="meal_date" label="日期" rules={[{ required: true }]}><DatePicker /></Form.Item><Form.Item name="meal_type" label="餐次" rules={[{ required: true }]}><select className="native-form-select">{mealTypes.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Form.Item><Form.Item name="dish_ids" label="选择菜品"><DishMultiSelect dishes={dishes} /></Form.Item><Form.Item name="custom_name" label="或填写其他餐食"><Input /></Form.Item><Form.Item name="estimated_kcal" label="这餐热量（kcal，可选）"><InputNumber min={0} max={10000} placeholder="留空自动粗估" /></Form.Item></> : null}
        {modal === 'shopping' || modal === 'shoppingList' ? <Form.Item name="name" label="清单名称" initialValue={modal === 'shopping' ? '本月采购' : '手动采购'} rules={[{ required: true }]}><Input /></Form.Item> : null}
        {modal === 'shoppingItem' ? <><Form.Item name="ingredient_name" label="物品名称" rules={[{ required: true, whitespace: true }]}><Input /></Form.Item><Form.Item name="quantity_text" label="数量或备注"><Input placeholder="例如：2斤、按需" /></Form.Item></> : null}
      </Form>
    </Modal>
    <Modal title="确认删除这餐？" centered width={440} open={deleteConfirmOpen && Boolean(editingMeal)} onOk={() => void deleteMeal()} onCancel={() => { if (!deleting) { setDeleteConfirmOpen(false); setDeleteError('') } }} okText="确认" cancelText="取消" confirmLoading={deleting} okButtonProps={{ danger: true, disabled: saving || deleting }} cancelButtonProps={{ disabled: deleting }} closable={!deleting} keyboard={!deleting} mask={{ closable: !deleting }}>
      <Typography.Paragraph>这条饮食安排将从饮食日历、首页、今日计划和搜索中移除，可在回收站恢复。</Typography.Paragraph>
      {deleteError ? <Alert type="error" showIcon title={deleteError} /> : null}
    </Modal>
  </div>
}
