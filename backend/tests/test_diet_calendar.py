from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models import AgendaItem, MealPlan


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    with TestClient(app) as client:
        client.headers['x-local-token'] = app.state.local_token
        yield client
    app.state.database.dispose()


def create_meal(client, meal_date='2026-10-07', **values):
    response = client.post('/api/v1/diet/meals', json={
        'meal_date': meal_date, 'meal_type': 'lunch', 'custom_name': '测试餐食', **values,
    })
    assert response.status_code == 201
    return response.json()


def assert_hidden(client, meal, target='2026-10-07'):
    assert client.get('/api/v1/diet/meals', params={
        'start_date': '2026-01-01', 'end_date': '2027-12-31',
    }).json() == []
    assert client.get('/api/v1/agenda', params={'date': meal['meal_date']}).json() == []
    home = client.get('/api/v1/home', params={'date': target}).json()
    assert home['agenda'] == []
    assert home['stats']['total'] == 0
    assert home['stats']['overdue'] == 0
    assert home['stats']['due_soon'] == 0
    assert home['summaries']['diet']['count'] == 0
    assert client.get('/api/v1/search', params={'q': '测试餐食'}).json() == []
    assert client.get(f"/api/v1/agenda/{meal['agenda_id']}").status_code == 404
    assert client.patch(f"/api/v1/diet/meals/{meal['id']}", json={
        'meal_date': meal['meal_date'], 'meal_type': 'lunch', 'custom_name': '重新出现',
    }).status_code == 404


def test_calendar_range_includes_adjacent_months_and_all_same_type_meals(client):
    for meal_date in ['2026-09-27', '2026-09-28', '2026-10-07', '2026-10-31', '2026-11-01', '2026-11-02']:
        create_meal(client, meal_date)
    extra = create_meal(client)
    deleted = create_meal(client)
    assert client.delete(f"/api/v1/diet/meals/{deleted['id']}").status_code == 200
    meals = client.get('/api/v1/diet/meals', params={
        'start_date': '2026-09-28', 'end_date': '2026-11-01',
    }).json()
    assert len(meals) == 5
    assert [item['meal_date'] for item in meals] == ['2026-09-28', '2026-10-07', '2026-10-07', '2026-10-31', '2026-11-01']
    assert extra['id'] in {item['id'] for item in meals}
    assert deleted['id'] not in {item['id'] for item in meals}


def test_edit_meal_date_type_and_actual_food_updates_every_projection(client):
    meal = create_meal(client, '2026-10-31')
    response = client.patch(f"/api/v1/diet/meals/{meal['id']}", json={
        'meal_date': '2026-11-01', 'meal_type': 'dinner',
        'custom_name': '蒸鱼', 'actual_food': '蒸鱼和蔬菜',
    })
    assert response.status_code == 200
    assert response.json()['actual_food'] == '蒸鱼和蔬菜'
    assert client.get('/api/v1/agenda', params={'date': '2026-10-31'}).json() == []
    home = client.get('/api/v1/home', params={'date': '2026-11-01'}).json()
    assert [item['title'] for item in home['agenda']] == ['晚餐：蒸鱼']
    assert home['summaries']['diet']['title'] == '下一餐：蒸鱼'
    assert home['summaries']['diet']['count'] == 1
    assert client.get('/api/v1/search', params={'q': '测试餐食'}).json() == []
    assert len(client.get('/api/v1/search', params={'q': '蒸鱼'}).json()) == 1


@pytest.mark.parametrize('meal_date,completed', [
    ('2026-10-06', False), ('2026-10-07', False),
    ('2026-10-07', True), ('2026-10-09', False),
])
def test_deleted_meal_disappears_from_calendar_home_today_search_and_statistics(client, meal_date, completed):
    meal = create_meal(client, meal_date)
    if completed:
        assert client.post(f"/api/v1/agenda/{meal['agenda_id']}/complete").status_code == 200
    assert client.get('/api/v1/search', params={'q': '测试餐食'}).json()
    response = client.delete(f"/api/v1/diet/meals/{meal['id']}")
    assert response.status_code == 200
    assert_hidden(client, meal)
    assert client.delete(f"/api/v1/diet/meals/{meal['id']}").status_code == 404


@pytest.mark.parametrize('missing_pointer', [True, False])
def test_deletion_also_removes_legacy_agendas_with_incomplete_links(client, missing_pointer):
    meal = create_meal(client)
    with client.app.state.database.session() as session:
        if missing_pointer:
            session.get(MealPlan, meal['id']).agenda_id = None
        else:
            original = session.get(AgendaItem, meal['agenda_id'])
            original.source_type = None
            original.source_id = None
            session.flush()
            session.add(AgendaItem(
                id='legacy-duplicate', title='午餐：测试餐食', plan_date=date(2026, 10, 7),
                module='diet', source_type='meal_plan', source_id=meal['id'],
            ))
    assert len(client.get('/api/v1/agenda', params={'date': '2026-10-07'}).json()) == (1 if missing_pointer else 2)
    assert client.delete(f"/api/v1/diet/meals/{meal['id']}").status_code == 200
    assert_hidden(client, meal)
    if not missing_pointer:
        assert client.get('/api/v1/agenda/legacy-duplicate').status_code == 404


def test_deleting_a_meal_from_today_also_removes_it_from_the_diet_calendar(client):
    meal = create_meal(client)
    assert client.delete(f"/api/v1/agenda/{meal['agenda_id']}").status_code == 200
    assert_hidden(client, meal)


def test_deleting_one_meal_preserves_other_plans_dishes_and_health_and_excludes_shopping(client):
    dish = client.post('/api/v1/diet/dishes', json={
        'name': '蒸鱼', 'ingredients': [{'name': '鱼', 'quantity': 1, 'unit': '条'}],
    }).json()
    meal = create_meal(client, dish_id=dish['id'])
    other = create_meal(client, meal_type='dinner', custom_name='保留餐食')
    assert client.put('/api/v1/diet/health/2026-10-07', json={'water_ml': 1800}).status_code == 200
    assert client.delete(f"/api/v1/diet/meals/{meal['id']}").status_code == 200
    home = client.get('/api/v1/home', params={'date': '2026-10-07'}).json()
    assert [item['source_id'] for item in home['agenda']] == [other['id']]
    assert home['summaries']['diet']['count'] == 1
    assert home['summaries']['diet']['title'] == '下一餐：保留餐食'
    assert client.get('/api/v1/diet/dishes').json()[0]['id'] == dish['id']
    assert client.get('/api/v1/diet/health/2026-10-07').json()['water_ml'] == 1800
    shopping = client.post('/api/v1/diet/shopping-lists/generate', json={
        'name': '本月采购', 'start_date': '2026-10-01', 'end_date': '2026-10-31',
    })
    assert shopping.status_code == 201
    assert shopping.json()['items'] == []


def test_explicit_restore_is_required_for_a_deleted_meal_to_reappear(client):
    meal = create_meal(client)
    assert client.delete(f"/api/v1/diet/meals/{meal['id']}").status_code == 200
    assert_hidden(client, meal)
    assert client.post(f"/api/v1/trash/meal/{meal['id']}/restore").status_code == 200
    home = client.get('/api/v1/home', params={'date': '2026-10-07'}).json()
    assert home['summaries']['diet']['count'] == 1
    assert [item['source_id'] for item in home['agenda']] == [meal['id']]
