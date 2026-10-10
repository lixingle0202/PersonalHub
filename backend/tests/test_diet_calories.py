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
    assert (meal['display_kcal'], meal['calorie_source']) == (600, '餐次粗估')
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
