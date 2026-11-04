import math

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.calories import ingredient_energy, normalized_name, reference_food, split_meal_foods
from app.services.food_catalog import FOODS, COMMON_NAMES, lookup_food
from app.services.food_catalog_data import SOURCE_RELEASE, SOURCE_URL, SOURCE_ZIP_SHA256
from app.services.food_reference import REFERENCE_RECIPES


def test_bundled_catalog_has_valid_energy_records_and_traceable_provenance():
    assert len(FOODS) == 2213
    assert len({food.code for food in FOODS}) == len(FOODS)
    assert all(food.name and food.description and math.isfinite(food.kcal_100g) and 0 <= food.kcal_100g <= 1000 for food in FOODS)
    assert SOURCE_RELEASE == '2026-10-05'
    assert SOURCE_URL == 'https://data.gov.tw/dataset/8543'
    assert len(SOURCE_ZIP_SHA256) == 64
    assert all(lookup_food(name) is not None for name in COMMON_NAMES)
    for food in FOODS:
        assert reference_food(food.name) is not None, food.name
        assert split_meal_foods(food.name) == [normalized_name(food.name)], food.name
        assert split_meal_foods(food.name + '100g\n米饭200g') == [normalized_name(food.name) + '100g', '米饭200g'], food.name


def test_every_example_recipe_has_complete_ingredient_energy_and_weighted_estimates():
    assert len(REFERENCE_RECIPES) >= 100
    for name, recipe in REFERENCE_RECIPES.items():
        assert all(ingredient_energy(food, amount, unit) is not None for food, amount, unit in recipe), name
        portion = reference_food(name)
        weighted = reference_food(name + '200g')
        assert portion and portion[0] > 0 and portion[1] == '参考配方', name
        assert weighted and weighted[0] > 0 and '近似成品重量' in weighted[2], name


def test_catalog_foods_work_with_weight_aliases_and_disclosed_default_grams():
    for name in ['小笼包', '小籠包', '葱油饼', '卤猪脚', '嫩豆腐', '长茄子', '酸菜', '韭菜盒子']:
        food = lookup_food(name)
        assert food is not None
        estimate = reference_food(name + '200g')
        assert estimate is not None and estimate[0] == food.kcal_100g * 2
        assert estimate[1] == '食物数据库'
        assert food.code in estimate[2] and '可食部分' in estimate[2]
    assumed = reference_food('小笼包')
    assert assumed is not None and '暂按每份100克' in assumed[2]
    assert reference_food('神秘小笼包200g') is None
    assert reference_food('猪肉200g')[0] == 480
    names = split_meal_foods('条状肉干(牛肉,黑胡椒)100g+米饭200g')
    assert names == ['条状肉干(牛肉,黑胡椒)100g', '米饭200g']


def test_search_catalog_is_bounded_and_has_common_dishes_and_dataset_attribution(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    with TestClient(app) as browser:
        browser.headers['x-local-token'] = app.state.local_token
        response = browser.get('/api/v1/diet/food-references', params={'q': '宫保', 'limit': 5})
        assert response.status_code == 200
        data = response.json()
        assert data['food_count'] == 2213 and data['recipe_count'] >= 100
        assert data['source_url'] == SOURCE_URL
        assert data['items'][0]['name'] == '宫保鸡丁'
        assert len(data['items']) <= 5
        assert any(item['name'] == '小笼包' for item in browser.get('/api/v1/diet/food-references?q=小笼包').json()['items'])
        assert browser.get('/api/v1/diet/food-references?limit=10000').status_code == 422
        assert browser.get('/api/v1/diet/food-references', params={'q': 'a' * 101}).status_code == 422
        for item in browser.get('/api/v1/diet/food-references?q=大蒜').json()['items']:
            if item['name'] == '大蒜':
                assert '149 kcal/100克' in item['label']
                assert reference_food('大蒜100g')[0] == 149
    app.state.database.dispose()
