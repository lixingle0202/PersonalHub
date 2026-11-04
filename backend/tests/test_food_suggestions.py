from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.calories import food_suggestions, reference_food
from app.services.food_reference import REFERENCE_RECIPES


def test_new_dishes_have_complete_references_including_the_reported_golden_egg():
    assert len(REFERENCE_RECIPES) == 190
    for name in ['小炒金钱蛋', '金钱蛋', '虎皮蛋', '香干炒肉', '水煮肉片', '黑椒牛柳', '咖喱鸡',
                 '大盘鸡', '紫菜蛋花汤', '蒜蓉粉丝蒸虾', '鱼香肉丝盖饭', '白菜猪肉炖粉条']:
        value = reference_food(name)
        weighted = reference_food(name + '200g')
        assert value and value[0] > 0 and value[1] == '参考配方', name
        assert weighted and weighted[0] > 0, name
    # Example portion: 150g eggs + 100g pepper + 5g garlic + 10g oil + 10g soy sauce.
    assert round(reference_food('小炒金钱蛋')[0], 2) == 331.15


def test_suggestions_prioritize_close_names_support_keywords_and_deduplicate_aliases():
    exact = food_suggestions('小炒金钱蛋')['items']
    assert exact[0]['name'] == '小炒金钱蛋'
    aliases = food_suggestions('金钱蛋')['items']
    assert [item['name'] for item in aliases].count('小炒金钱蛋') == 1
    assert all('kcal' in item['label'] for item in aliases)
    assert food_suggestions('香辣金钱')['items'][0]['name'] == '小炒金钱蛋'
    assert food_suggestions('白饭')['items'][0]['name'] == '米饭'
    potatoes = food_suggestions('土豆', 30)['items']
    assert len(potatoes) >= 8
    assert not any('花生' in item['name'] for item in potatoes)
    assert len({item['name'] for item in potatoes}) == len(potatoes)
    assert {'土豆炖牛肉', '土豆牛肉盖饭'} <= {item['name'] for item in food_suggestions('土豆 牛肉')['items']}
    assert len(food_suggestions('金钱', 1)['items']) == 1
    assert food_suggestions('完全不存在的菜名')['items'] == []


def test_the_reported_three_dishes_have_a_complete_total_and_saved_breakdown(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    with TestClient(app) as browser:
        browser.headers['x-local-token'] = app.state.local_token
        payload = {'custom_name': '农家小炒肉\n西红柿炒鸡蛋\n小炒金钱蛋', 'servings': 1}
        preview = browser.post('/api/v1/diet/calories/estimate', json=payload)
        assert preview.status_code == 200
        result = preview.json()
        assert result['display_kcal'] == 1128  # 532.27 + 264.72 + 331.15, rounded once.
        assert len(result['calorie_items']) == 3 and all(item['kcal'] is not None for item in result['calorie_items'])
        saved = browser.post('/api/v1/diet/meals', json={**payload, 'meal_date': '2026-11-04', 'meal_type': 'lunch'})
        assert saved.status_code == 201
        assert saved.json()['calorie_items'] == result['calorie_items']
        assert saved.json()['display_kcal'] == 1128
        found = browser.get('/api/v1/diet/food-references?q=金钱').json()
        assert found['recipe_count'] == 190
        assert found['items'][0]['name'] == '小炒金钱蛋'
    app.state.database.dispose()
