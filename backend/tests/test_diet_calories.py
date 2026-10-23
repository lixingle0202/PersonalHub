import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    with TestClient(app) as client:
        client.headers['x-local-token'] = app.state.local_token
        yield client
    app.state.database.dispose()


def test_meal_estimate_uses_ingredients_and_can_be_overridden(client):
    dish = client.post('/api/v1/diet/dishes', json={
        'name': '西红柿炒鸡蛋', 'ingredients': [
            {'name': '鸡蛋', 'quantity': 2, 'unit': '个'},
            {'name': '番茄', 'quantity': 2, 'unit': '个'},
            {'name': '食用油', 'quantity': 10, 'unit': '克'},
        ],
    }).json()
    base = {'meal_date': '2026-10-09', 'meal_type': 'lunch', 'dish_id': dish['id']}
    meal = client.post('/api/v1/diet/meals', json=base).json()
    assert (meal['display_kcal'], meal['calorie_source']) == (282, '食材粗估')
    manual = client.patch(f"/api/v1/diet/meals/{meal['id']}", json={**base, 'estimated_kcal': 320}).json()
    assert (manual['display_kcal'], manual['calorie_source']) == (320, '手动填写')
    assert client.get('/api/v1/diet/meals', params={'start_date': '2026-10-09', 'end_date': '2026-10-09'}).json()[0]['display_kcal'] == 320


def test_profile_is_persisted_and_unknown_food_is_labelled_coarse(client):
    assert client.get('/api/v1/diet/profile').json() == {'height_cm': None, 'weight_kg': None}
    assert client.put('/api/v1/diet/profile', json={'height_cm': 175, 'weight_kg': 68}).status_code == 200
    assert client.get('/api/v1/diet/profile').json() == {'height_cm': 175, 'weight_kg': 68}
    meal = client.post('/api/v1/diet/meals', json={'meal_date': '2026-10-09', 'meal_type': 'dinner', 'custom_name': '新菜名'}).json()
    assert (meal['display_kcal'], meal['calorie_source']) == (None, '待补充')
    assert '新菜名' in meal['calorie_explanation']
    assert client.put('/api/v1/diet/profile', json={'height_cm': 0, 'weight_kg': 68}).status_code == 422


def test_multiple_dishes_share_one_meal_and_update_all_views(client):
    rice = client.post('/api/v1/diet/dishes', json={
        'name': '米饭', 'estimated_kcal': 260,
        'ingredients': [{'name': '大米', 'quantity': 100, 'unit': '克'}],
    }).json()
    eggs = client.post('/api/v1/diet/dishes', json={
        'name': '番茄炒蛋', 'estimated_kcal': 180,
        'ingredients': [{'name': '鸡蛋', 'quantity': 2, 'unit': '个'}],
    }).json()
    base = {'meal_date': '2026-10-09', 'meal_type': 'lunch'}
    created = client.post('/api/v1/diet/meals', json={**base, 'dish_ids': [rice['id'], eggs['id']]})
    assert created.status_code == 201
    meal = created.json()
    assert (meal['dish_ids'], meal['dish_id'], meal['dish_name']) == ([rice['id'], eggs['id']], rice['id'], '米饭、番茄炒蛋')
    assert (meal['display_kcal'], meal['calorie_source']) == (440, '菜品设置')
    assert client.get('/api/v1/agenda', params={'date': '2026-10-09'}).json()[0]['title'] == '午餐：米饭、番茄炒蛋'
    assert client.get('/api/v1/home', params={'date': '2026-10-09'}).json()['summaries']['diet']['title'] == '下一餐：米饭、番茄炒蛋'
    assert client.get('/api/v1/diet/meals', params={'start_date': '2026-10-09', 'end_date': '2026-10-09'}).json()[0]['dish_ids'] == [rice['id'], eggs['id']]
    shopping = client.post('/api/v1/diet/shopping-lists/generate', json={
        'name': '本月采购', 'start_date': '2026-10-01', 'end_date': '2026-10-31',
    }).json()
    assert {item['ingredient_name']: item['quantity_text'] for item in shopping['items']} == {'大米': '100克', '鸡蛋': '2个'}

    changed = client.patch(f"/api/v1/diet/meals/{meal['id']}", json={**base, 'dish_ids': [eggs['id']]}).json()
    assert (changed['dish_ids'], changed['dish_name'], changed['display_kcal']) == ([eggs['id']], '番茄炒蛋', 180)
    assert client.get('/api/v1/agenda', params={'date': '2026-10-09'}).json()[0]['title'] == '午餐：番茄炒蛋'
    assert client.post('/api/v1/diet/meals', json={**base, 'dish_ids': [rice['id'], rice['id']]}).status_code == 422
    assert client.patch(f"/api/v1/diet/meals/{meal['id']}", json={**base, 'dish_ids': ['missing']}).status_code == 404
    assert client.get('/api/v1/diet/meals', params={'start_date': '2026-10-09', 'end_date': '2026-10-09'}).json()[0]['dish_ids'] == [eggs['id']]

    legacy = client.post('/api/v1/diet/meals', json={**base, 'dish_id': rice['id']}).json()
    assert legacy['dish_ids'] == [rice['id']]


def test_generated_monthly_shopping_can_be_extended_edited_and_deleted(client):
    dish = client.post('/api/v1/diet/dishes', json={
        'name': '米饭', 'ingredients': [{'name': '大米', 'quantity': 100, 'unit': '克'}],
    }).json()
    for meal_date in ['2026-10-09', '2026-10-10', '2026-11-01']:
        client.post('/api/v1/diet/meals', json={
            'meal_date': meal_date, 'meal_type': 'lunch', 'dish_id': dish['id'],
        })
    base = '/api/v1/diet'
    period = {'name': '十月采购', 'start_date': '2026-10-01', 'end_date': '2026-10-31'}
    generated = client.post(base + '/shopping-lists/generate', json=period).json()
    assert [(item['ingredient_name'], item['quantity_text']) for item in generated['items']] == [('大米', '200克')]
    created = client.post(f"{base}/shopping-lists/{generated['id']}/items", json={
        'ingredient_name': '牛奶', 'quantity_text': '2盒',
    })
    assert created.status_code == 201 and created.json()['is_manual'] is True
    item_id = created.json()['id']
    changed = client.patch(f'{base}/shopping-items/{item_id}', json={
        'ingredient_name': '酸奶', 'quantity_text': '3盒', 'is_completed': True,
    })
    assert changed.status_code == 200
    items = client.get(base + '/shopping-lists').json()[0]['items']
    assert [(item['ingredient_name'], item['quantity_text'], item['is_completed']) for item in items] == [
        ('大米', '200克', False), ('酸奶', '3盒', True),
    ]
    assert client.delete(f'{base}/shopping-items/{item_id}').status_code == 200
    assert [item['ingredient_name'] for item in client.get(base + '/shopping-lists').json()[0]['items']] == ['大米']
    empty = client.post(base + '/shopping-lists', json={**period, 'name': '手动采购'})
    assert empty.status_code == 201 and empty.json()['items'] == []


@pytest.mark.parametrize('use_common_dish', [False, True])
def test_same_red_bean_rice_balls_have_identical_calories_for_every_meal_type(client, use_common_dish):
    selection = {'custom_name': '红豆小丸子'}
    if use_common_dish:
        dish = client.post('/api/v1/diet/dishes', json={'name': '红豆小丸子'}).json()
        selection = {'dish_id': dish['id']}
    meals = []
    for kind in ['breakfast', 'lunch', 'dinner', 'snack']:
        response = client.post('/api/v1/diet/meals', json={
            'meal_date': '2026-10-23', 'meal_type': kind, **selection,
        })
        assert response.status_code == 201
        meals.append(response.json())
    # Reference recipe: 200 g red bean sweet soup (66/100 g) + 50 g plain balls (258/100 g).
    assert [meal['display_kcal'] for meal in meals] == [261] * 4
    assert all(meal['calorie_source'] == '参考配方' for meal in meals)
    assert all('200克' in meal['calorie_explanation'] and '包装重量' in meal['calorie_explanation'] for meal in meals)
    stored = client.get('/api/v1/diet/meals', params={'start_date': '2026-10-23', 'end_date': '2026-10-23'}).json()
    assert [meal['display_kcal'] for meal in stored] == [261] * 4


def test_explicit_food_weights_and_portions_are_preserved_and_manual_total_wins(client):
    base = {'meal_date': '2026-10-23', 'meal_type': 'lunch', 'custom_name': '米饭200克+鸡蛋1个'}
    meal = client.post('/api/v1/diet/meals', json={**base, 'servings': 2}).json()
    assert meal['display_kcal'] == (260 + 70) * 2
    assert meal['servings'] == 2
    half = client.patch(f"/api/v1/diet/meals/{meal['id']}", json={**base, 'servings': 0.5}).json()
    assert half['display_kcal'] == 165 and half['servings'] == 0.5
    manual = client.patch(f"/api/v1/diet/meals/{meal['id']}", json={**base, 'servings': 2, 'estimated_kcal': 320}).json()
    assert (manual['display_kcal'], manual['calorie_source']) == (320, '手动填写')
    zero = client.patch(f"/api/v1/diet/meals/{meal['id']}", json={**base, 'servings': 2, 'estimated_kcal': 0}).json()
    assert zero['display_kcal'] == 0


def test_recipe_servings_and_consumed_portions_scale_calories_and_shopping(client):
    dish = client.post('/api/v1/diet/dishes', json={
        'name': '两人份番茄炒蛋', 'recipe_servings': 2,
        'ingredients': [{'name': '鸡蛋', 'quantity': 2, 'unit': '个'},
                        {'name': '番茄', 'quantity': 2, 'unit': '个'},
                        {'name': '食用油', 'quantity': 10, 'unit': '克'},
                        {'name': '盐', 'quantity': None, 'unit': '少许'}],
    }).json()
    meal = client.post('/api/v1/diet/meals', json={
        'meal_date': '2026-10-23', 'meal_type': 'dinner', 'dish_id': dish['id'], 'servings': 0.5,
    }).json()
    assert meal['display_kcal'] == round((140 + 54 + 88.4) / 2 * 0.5)
    assert '÷ 2份' in meal['calorie_explanation']
    shopping = client.post('/api/v1/diet/shopping-lists/generate', json={
        'name': '按实际份数采购', 'start_date': '2026-10-23', 'end_date': '2026-10-23',
    }).json()
    amounts = {item['ingredient_name']: item['quantity_text'] for item in shopping['items']}
    assert amounts['鸡蛋'] == '0.5个' and amounts['食用油'] == '2.5克'


def test_incomplete_or_misidentified_foods_do_not_get_a_fabricated_total(client):
    known = client.post('/api/v1/diet/dishes', json={'name': '米饭', 'estimated_kcal': 260}).json()
    unknown = client.post('/api/v1/diet/dishes', json={
        'name': '鸡蛋糕', 'ingredients': [{'name': '鸡蛋糕', 'quantity': 100, 'unit': '克'}],
    }).json()
    meal = client.post('/api/v1/diet/meals', json={
        'meal_date': '2026-10-23', 'meal_type': 'dinner', 'dish_ids': [known['id'], unknown['id']],
    }).json()
    assert meal['display_kcal'] is None and meal['calorie_source'] == '待补充'
    assert '鸡蛋糕' in meal['calorie_explanation']


@pytest.mark.parametrize('weight', ['米饭0.2kg', '米饭4两', '米饭0.4斤', '米饭200g'])
def test_common_weight_units_give_the_same_energy(client, weight):
    meal = client.post('/api/v1/diet/meals', json={
        'meal_date': '2026-10-23', 'meal_type': 'breakfast', 'custom_name': weight,
    }).json()
    assert meal['display_kcal'] == 260


@pytest.mark.parametrize('servings', [0, -1, 21])
def test_invalid_meal_portions_are_rejected(client, servings):
    response = client.post('/api/v1/diet/meals', json={
        'meal_date': '2026-10-23', 'meal_type': 'lunch', 'custom_name': '米饭', 'servings': servings,
    })
    assert response.status_code == 422
