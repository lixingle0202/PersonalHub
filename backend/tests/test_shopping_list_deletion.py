from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models import ShoppingItem, ShoppingList
from app.public import create_public_app


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    with TestClient(app) as browser:
        browser.headers['x-local-token'] = app.state.local_token
        yield browser
    app.state.database.dispose()


def create_list(client, generated=False):
    if generated:
        dish = client.post('/api/v1/diet/dishes', json={
            'name': '米饭', 'ingredients': [{'name': '大米', 'quantity': 100, 'unit': '克'}],
        }).json()
        client.post('/api/v1/diet/meals', json={'dish_id': dish['id'], 'meal_date': '2026-12-01', 'meal_type': 'lunch'})
    response = client.post('/api/v1/diet/shopping-lists' + ('/generate' if generated else ''), json={
        'name': '本月采购', 'start_date': '2026-12-01', 'end_date': '2026-12-31',
    })
    assert response.status_code == 201
    return response.json()


@pytest.mark.parametrize('generated', [False, True])
def test_empty_and_generated_lists_can_be_deleted_and_restored_with_all_contents(client, generated):
    shopping = create_list(client, generated)
    added = client.post(f"/api/v1/diet/shopping-lists/{shopping['id']}/items", json={
        'ingredient_name': '牛奶', 'quantity_text': '2盒',
    }).json()
    client.patch(f"/api/v1/diet/shopping-items/{added['id']}", json={'is_completed': True})
    kept = create_list(client)
    response = client.delete(f"/api/v1/diet/shopping-lists/{shopping['id']}")
    assert response.status_code == 200
    assert [row['id'] for row in client.get('/api/v1/diet/shopping-lists').json()] == [kept['id']]
    assert client.delete(f"/api/v1/diet/shopping-lists/{shopping['id']}").status_code == 404
    assert client.post(f"/api/v1/diet/shopping-lists/{shopping['id']}/items", json={'ingredient_name': '不能新增'}).status_code == 404
    group = client.get('/api/v1/trash').json()[0]
    assert group['id'] == shopping['id']
    assert len(group['children']) == (2 if generated else 1)
    assert client.post(f"/api/v1/trash/shopping_list/{shopping['id']}/restore").status_code == 200
    restored = next(row for row in client.get('/api/v1/diet/shopping-lists').json() if row['id'] == shopping['id'])
    assert next(row for row in restored['items'] if row['id'] == added['id'])['is_completed'] is True
    if generated:
        assert len(client.get('/api/v1/diet/meals?start_date=2026-12-01&end_date=2026-12-31').json()) == 1
        assert len(client.get('/api/v1/agenda?date=2026-12-01').json()) == 1


def test_deleting_a_list_preserves_previously_deleted_items_and_allows_individual_recovery(client):
    shopping = create_list(client)
    item = client.post(f"/api/v1/diet/shopping-lists/{shopping['id']}/items", json={'ingredient_name': '旧购物项'}).json()
    old_time = datetime(2020, 1, 1, tzinfo=timezone.utc)
    with client.app.state.database.session() as session:
        session.get(ShoppingItem, item['id']).deleted_at = old_time
    assert client.delete(f"/api/v1/diet/shopping-lists/{shopping['id']}").status_code == 200
    with client.app.state.database.session() as session:
        assert session.get(ShoppingItem, item['id']).deleted_at.replace(tzinfo=timezone.utc) == old_time
        assert session.get(ShoppingList, shopping['id']).deleted_at is not None
    assert client.post(f"/api/v1/trash/shopping_item/{item['id']}/restore").status_code == 200
    assert client.get('/api/v1/diet/shopping-lists').json()[0]['items'][0]['id'] == item['id']


def test_shopping_list_delete_is_committed_before_success_response_starts(client):
    shopping = create_list(client, True)
    observed = []

    class Probe:
        async def __call__(self, scope, receive, send):
            async def observe(message):
                if message['type'] == 'http.response.start':
                    with client.app.state.database.session() as session:
                        observed.append((session.get(ShoppingList, shopping['id']).deleted_at is not None,
                                         session.get(ShoppingItem, shopping['items'][0]['id']).deleted_at is not None))
                await send(message)
            await client.app(scope, receive, observe)

    with TestClient(Probe()) as browser:
        browser.headers['x-local-token'] = client.headers['x-local-token']
        assert browser.delete(f"/api/v1/diet/shopping-lists/{shopping['id']}").status_code == 200
    assert observed == [(True, True)]


def test_a_public_user_cannot_delete_another_users_shopping_list(tmp_path):
    public = create_public_app(tmp_path / 'shared')
    with TestClient(public, base_url='https://hub.example.test') as alice, TestClient(public, base_url='https://hub.example.test') as bob:
        for browser, name in [(alice, 'alice'), (bob, 'bob')]:
            assert browser.post('/api/v1/public/register', json={'username': name, 'password': 'long-test-password'}).status_code == 200
            browser.headers['x-local-token'] = browser.get('/api/v1/bootstrap').json()['local_token']
        shopping = create_list(alice)
        assert bob.delete(f"/api/v1/diet/shopping-lists/{shopping['id']}").status_code == 404
        assert alice.get('/api/v1/diet/shopping-lists').json()[0]['id'] == shopping['id']
