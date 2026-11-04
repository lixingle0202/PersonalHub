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


@pytest.mark.parametrize('text', [
    '米饭200g 西红柿炒鸡蛋', '米饭 200 g 西红柿 炒 鸡蛋',
    '米饭200克+西红柿炒鸡蛋', '米饭200克\n西红柿炒鸡蛋',
    '米饭200克，西红柿炒鸡蛋', '米饭200克和西红柿炒鸡蛋',
])
def test_multiple_foods_are_split_and_summed_with_individual_calories(client, text):
    estimate = client.post('/api/v1/diet/calories/estimate', json={'custom_name': text}).json()
    # Rice 260 + eggs 140 + tomatoes 54 + oil 70.72.
    assert estimate['display_kcal'] == 525
    assert len(estimate['calorie_items']) == 2
    assert estimate['calorie_items'][0]['kcal'] == 260
    assert estimate['calorie_items'][1]['kcal'] == 264.7
    assert '食用油' in estimate['calorie_items'][1]['explanation']


def test_common_dishes_and_additional_foods_both_count_and_survive_editing(client):
    rice = client.post('/api/v1/diet/dishes', json={'name': '自定米饭', 'estimated_kcal': 260}).json()
    selection = {'dish_ids': [rice['id']], 'custom_name': '西红柿炒鸡蛋0.5份\n牛奶250ml', 'servings': 2}
    preview = client.post('/api/v1/diet/calories/estimate', json=selection).json()
    assert preview['display_kcal'] == round((260 + 264.72 * 0.5 + 152.5) * 2)
    assert len(preview['calorie_items']) == 3
    assert preview['calorie_items'][0]['kcal'] == 520
    base = {'meal_date': '2026-11-04', 'meal_type': 'lunch'}
    saved = client.post('/api/v1/diet/meals', json={**base, **selection})
    assert saved.status_code == 201
    meal = saved.json()
    assert meal['display_kcal'] == preview['display_kcal']
    assert meal['calorie_items'] == preview['calorie_items']
    assert meal['dish_name'] == '自定米饭、西红柿炒鸡蛋0.5份、牛奶250ml'
    agenda = client.get('/api/v1/agenda?date=2026-11-04').json()[0]
    assert '自定米饭、西红柿炒鸡蛋0.5份、牛奶250ml' in agenda['title']
    listed = client.get('/api/v1/diet/meals?start_date=2026-11-04&end_date=2026-11-04').json()[0]
    assert listed['calorie_items'] == preview['calorie_items']
    updated = client.patch('/api/v1/diet/meals/' + meal['id'], json={
        **base, 'dish_ids': [rice['id']], 'custom_name': '牛奶250ml', 'servings': 1,
    }).json()
    assert updated['display_kcal'] == 412 and len(updated['calorie_items']) == 2
    assert updated['dish_name'] == '自定米饭、牛奶250ml'


@pytest.mark.parametrize('food', ['蛋炒饭200g', '鸡蛋炒饭200克', '蛋炒饭0.2kg', '蛋炒饭4两', '蛋炒饭0.4斤'])
def test_fried_rice_can_use_food_weight_with_disclosed_recipe_assumptions(client, food):
    result = client.post('/api/v1/diet/calories/estimate', json={'custom_name': food}).json()
    # Reference recipe: cooked rice 200 g + egg 50 g + carrot 30 g + oil 8 g.
    assert result['display_kcal'] == round((260 + 70 + 12.3 + 70.72) * 200 / 288)
    assert result['calorie_source'] == '参考配方'
    assert '食用200克' in result['calorie_explanation']
    assert '近似成品重量' in result['calorie_explanation']
    assert '食用油' in result['calorie_explanation']


def test_weighted_recipes_scale_by_weight_and_meal_servings_and_remain_meal_type_independent(client):
    values = []
    for kind in ['breakfast', 'lunch', 'dinner', 'snack']:
        meal = client.post('/api/v1/diet/meals', json={
            'meal_date': '2026-11-04', 'meal_type': kind, 'custom_name': '蛋炒饭200g 西红柿炒鸡蛋100克',
        }).json()
        values.append(meal['display_kcal'])
    assert len(set(values)) == 1 and values[0] > 0
    single = client.post('/api/v1/diet/calories/estimate', json={'custom_name': '蛋炒饭400g'}).json()
    doubled = client.post('/api/v1/diet/calories/estimate', json={'custom_name': '蛋炒饭200g', 'servings': 2}).json()
    assert single['display_kcal'] == doubled['display_kcal']


def test_unknown_food_is_visible_but_does_not_fabricate_a_complete_total(client):
    result = client.post('/api/v1/diet/calories/estimate', json={'custom_name': '米饭200g 鸡蛋糕100g'}).json()
    assert result['display_kcal'] is None and result['calorie_source'] == '待补充'
    assert result['calorie_known_kcal'] == 260
    assert [(item['name'], item['kcal']) for item in result['calorie_items']] == [('米饭200g', 260), ('鸡蛋糕100g', None)]
    assert '鸡蛋糕100g' in result['calorie_explanation']


@pytest.mark.parametrize('food', ['蛋炒饭0g', '蛋炒饭200ml', '蛋炒饭-10g', '神秘蛋炒饭200g'])
def test_invalid_amounts_and_unknown_dish_names_remain_unestimated(client, food):
    result = client.post('/api/v1/diet/calories/estimate', json={'custom_name': food}).json()
    assert result['display_kcal'] is None


def test_manual_whole_meal_total_still_wins_over_every_component_and_portion(client):
    for total in [0, 650]:
        result = client.post('/api/v1/diet/calories/estimate', json={
            'custom_name': '蛋炒饭200g 未知菜品', 'estimated_kcal': total, 'servings': 2,
        }).json()
        assert result['display_kcal'] == total and result['calorie_source'] == '手动填写'
        assert result['calorie_items'] == []
