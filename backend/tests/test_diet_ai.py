import json

import pytest
from fastapi.testclient import TestClient

from app.api import diet_ai
from app.config import Settings
from app.main import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    with TestClient(app) as client:
        client.headers['x-local-token'] = app.state.local_token
        yield client
    app.state.database.dispose()


def reply(days=1):
    return {'message': {'content': json.dumps({
        'name': '备考菜谱', 'description': '按份量调整',
        'meals': [{'day_number': day, 'meal_type': kind, 'name': f'第{day}天{kind}', 'estimated_kcal': kcal}
                  for day in range(1, days + 1)
                  for kind, kcal in [('breakfast', 400), ('lunch', 650), ('dinner', 600)]],
    }, ensure_ascii=False)}, 'done': True}


def test_shared_diet_model_generates_editable_plan_without_importing(client, monkeypatch):
    client.put('/api/v1/ai/ollama/settings', json={'base_url': 'http://127.0.0.1:11434', 'model': 'qwen2.5:1.5b'})
    def fake_ollama(settings, path, body):
        assert path == '/api/chat' and body['model'] == 'qwen2.5:1.5b'
        assert len(body['format']['properties']['meals']['prefixItems']) == 6
        assert body['format']['properties']['meals']['minItems'] == 6
        assert json.loads(body['messages'][1]['content']) == {'theme': '备考', 'preferences': '', 'days': 2}
        return reply(2)
    monkeypatch.setattr(diet_ai, 'ollama_request', fake_ollama)
    generated = client.post('/api/v1/ai/diet/generate', json={'theme': '备考', 'days': 2})
    assert generated.status_code == 200, generated.text
    assert generated.json()['plan']['cycle_days'] == 2
    assert len(generated.json()['plan']['meals']) == 6
    assert client.get('/api/v1/diet/meals', params={'start_date': '2026-10-09', 'end_date': '2026-10-10'}).json() == []


def test_visitor_diet_result_is_validated_before_template_save(client):
    prepared = client.post('/api/v1/ai/diet/visitor/prepare', json={'theme': '均衡', 'days': 1})
    assert prepared.status_code == 200 and prepared.json()['stream'] is False
    valid = client.post('/api/v1/ai/diet/visitor/draft', json={
        'requirements': {'theme': '均衡', 'days': 1}, 'content': reply()['message']['content'], 'done': True,
    })
    assert valid.status_code == 200 and valid.json()['plan']['meals'][0]['estimated_kcal'] == 400
    invalid = client.post('/api/v1/ai/diet/visitor/draft', json={
        'requirements': {'theme': '均衡', 'days': 1}, 'content': '{}', 'done': True,
    })
    assert invalid.status_code == 502
    assert len(client.get('/api/v1/diet/templates').json()) == 3
