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


def test_preset_import_repeats_cycle_without_overwriting_existing_meal(client):
    templates = client.get('/api/v1/diet/templates').json()
    assert {item['name'] for item in templates} >= {'减脂餐模板', '备考周饮食模板', '养胃饮食模板'}
    template = templates[0]
    existing = client.post('/api/v1/diet/meals', json={
        'meal_date': '2026-10-09', 'meal_type': 'breakfast', 'custom_name': '自己的早餐',
    }).json()
    path = f"/api/v1/diet/templates/{template['id']}/import"
    result = client.post(path, json={'start_date': '2026-10-09', 'days': 4})
    assert result.status_code == 200, result.text
    assert result.json() == {'imported': 11, 'skipped': 1, 'start_date': '2026-10-09', 'end_date': '2026-10-12'}
    meals = client.get('/api/v1/diet/meals', params={'start_date': '2026-10-09', 'end_date': '2026-10-12'}).json()
    assert len(meals) == 12
    assert any(meal['id'] == existing['id'] and meal['dish_name'] == '自己的早餐' for meal in meals)
    assert all(meal['display_kcal'] > 0 for meal in meals if meal['id'] != existing['id'])
    assert next(meal for meal in meals if meal['id'] == existing['id'])['display_kcal'] is None
    assert client.post(path, json={'start_date': '2026-10-09', 'days': 4}).json()['imported'] == 0


def test_manual_template_can_be_edited_imported_and_deleted(client):
    payload = {'name': '我的两日模板', 'description': '按需调整', 'cycle_days': 2, 'meals': [
        {'day_number': 1, 'meal_type': 'lunch', 'name': '米饭和鸡蛋', 'estimated_kcal': 520},
        {'day_number': 2, 'meal_type': 'lunch', 'name': '蔬菜面', 'estimated_kcal': 480},
    ]}
    created = client.post('/api/v1/diet/templates', json=payload)
    assert created.status_code == 201
    template_id = created.json()['id']
    updated = client.patch(f'/api/v1/diet/templates/{template_id}', json={**payload, 'name': '更新后的模板'})
    assert updated.json()['name'] == '更新后的模板'
    result = client.post(f'/api/v1/diet/templates/{template_id}/import', json={'start_date': '2026-10-09', 'days': 3}).json()
    assert result['imported'] == 3
    meals = client.get('/api/v1/diet/meals', params={'start_date': '2026-10-09', 'end_date': '2026-10-11'}).json()
    assert [meal['display_kcal'] for meal in meals] == [520, 480, 520]
    assert client.delete(f'/api/v1/diet/templates/{template_id}').status_code == 200
    assert not any(item['id'] == template_id for item in client.get('/api/v1/diet/templates').json())
    assert len(client.get('/api/v1/diet/meals', params={'start_date': '2026-10-09', 'end_date': '2026-10-11'}).json()) == 3


def test_invalid_template_does_not_create_records(client):
    response = client.post('/api/v1/diet/templates', json={'name': '重复', 'cycle_days': 1, 'meals': [
        {'day_number': 1, 'meal_type': 'dinner', 'name': 'A', 'estimated_kcal': 400},
        {'day_number': 1, 'meal_type': 'dinner', 'name': 'B', 'estimated_kcal': 500},
    ]})
    assert response.status_code == 422
    assert len(client.get('/api/v1/diet/templates').json()) == 3
