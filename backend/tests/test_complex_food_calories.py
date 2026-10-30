import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    with TestClient(app) as browser:
        browser.headers['x-local-token'] = app.state.local_token
        yield browser
    app.state.database.dispose()


@pytest.mark.parametrize('name', ['农家小炒肉', '小炒肉', '农家小炒肉2份', '青椒肉丝', '平菇炒肉', '土豆炖牛肉', '西红柿炒鸡蛋'])
def test_common_complex_dishes_have_disclosed_ingredient_based_reference_estimates(client, name):
    meal = client.post('/api/v1/diet/meals', json={'meal_date': '2026-12-01', 'meal_type': 'lunch', 'custom_name': name}).json()
    assert meal['display_kcal'] > 0 and meal['calorie_source'] == '参考配方'
    assert '食用油' in meal['calorie_explanation'] and '示例用量' in meal['calorie_explanation']
    assert 'kcal' in meal['calorie_explanation']


def test_stir_fry_reference_scales_consistently_by_portions_and_not_meal_type(client):
    values = []
    for kind in ['breakfast', 'lunch', 'dinner', 'snack']:
        values.append(client.post('/api/v1/diet/meals', json={
            'meal_date': '2026-12-01', 'meal_type': kind, 'custom_name': '农家小炒肉',
        }).json()['display_kcal'])
    # Explicit example: belly 120 g + pepper 150 g + garlic 5 g + oil 8 g + soy sauce 10 g.
    assert values == [532] * 4
    half = client.post('/api/v1/diet/meals', json={
        'meal_date': '2026-12-01', 'meal_type': 'lunch', 'custom_name': '农家小炒肉', 'servings': 0.5,
    }).json()
    assert half['display_kcal'] == 266


def test_actual_recipe_and_manual_calories_take_priority_and_explain_each_ingredient(client):
    dish = client.post('/api/v1/diet/dishes', json={'name': '农家小炒肉', 'recipe_servings': 2, 'ingredients': [
        {'name': '五花肉（切片）', 'quantity': 200, 'unit': '克'},
        {'name': '青椒丝', 'quantity': 200, 'unit': 'g'},
        {'name': '蒜末', 'quantity': 5, 'unit': '克'},
        {'name': '生抽', 'quantity': 10, 'unit': '克'},
        {'name': '食用油', 'quantity': 10, 'unit': '克'},
    ]}).json()
    meal = client.post('/api/v1/diet/meals', json={
        'meal_date': '2026-12-01', 'meal_type': 'lunch', 'dish_id': dish['id'],
    }).json()
    assert meal['display_kcal'] == round((698 + 40 + 7.45 + 5.3 + 88.4) / 2)
    assert meal['calorie_source'] == '食材粗估'
    assert '五花肉（切片）200克≈698 kcal' in meal['calorie_explanation']
    assert '÷ 2份' in meal['calorie_explanation']
    changed = client.patch(f"/api/v1/diet/meals/{meal['id']}", json={
        'meal_date': '2026-12-01', 'meal_type': 'dinner', 'dish_id': dish['id'], 'estimated_kcal': 375,
    }).json()
    assert changed['display_kcal'] == 375 and changed['calorie_source'] == '手动填写'


def test_missing_quantities_are_disclosed_and_unknown_ingredients_are_not_silently_ignored(client):
    dish = client.post('/api/v1/diet/dishes', json={'name': '农家小炒肉', 'ingredients': [
        {'name': '五花肉', 'quantity': 120, 'unit': '克'},
        {'name': '青椒', 'quantity': None, 'unit': '适量'},
        {'name': '食用油', 'quantity': 8, 'unit': '克'},
    ]}).json()
    meal = client.post('/api/v1/diet/meals', json={'meal_date': '2026-12-01', 'meal_type': 'lunch', 'dish_id': dish['id']}).json()
    assert meal['display_kcal'] == round(418.8 + 30 + 70.72)
    assert meal['calorie_source'] == '参考配方' and '青椒150克≈30 kcal（参考用量）' in meal['calorie_explanation']
    unknown = client.post('/api/v1/diet/dishes', json={'name': '农家小炒肉', 'ingredients': [
        {'name': '神秘酱料', 'quantity': 30, 'unit': '克'},
    ]}).json()
    response = client.post('/api/v1/diet/meals', json={'meal_date': '2026-12-01', 'meal_type': 'lunch', 'dish_id': unknown['id']}).json()
    assert response['display_kcal'] is None and '神秘酱料' in response['calorie_explanation']


def test_calorie_preview_matches_saved_meal_without_creating_records(client):
    selection = {'custom_name': '农家小炒肉+米饭200克', 'servings': 0.5}
    response = client.post('/api/v1/diet/calories/estimate', json=selection)
    assert response.status_code == 200
    assert response.json()['display_kcal'] == 396
    assert client.get('/api/v1/diet/meals?start_date=2026-12-01&end_date=2026-12-31').json() == []
    assert client.get('/api/v1/agenda?date=2026-12-01').json() == []
    saved = client.post('/api/v1/diet/meals', json={**selection, 'meal_date': '2026-12-01', 'meal_type': 'lunch'}).json()
    assert saved['display_kcal'] == response.json()['display_kcal']
    assert saved['calorie_explanation'] == response.json()['calorie_explanation']
    assert client.post('/api/v1/diet/calories/estimate', json={'custom_name': '米饭', 'servings': 0}).status_code == 422
