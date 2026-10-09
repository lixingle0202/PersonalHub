from copy import deepcopy
import json

import httpx
import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.main import create_app
from app.migrations import migrate_database, migration_config
from app.database import Database
from app.models import AILearningDraft, AgendaItem, LearningGoal, QuickNote
from app.services import ollama

REAL_CLIENT = httpx.Client
CONFIG = {'base_url': 'http://127.0.0.1:11434', 'model': 'qwen2.5:3b'}
REQUIREMENTS = {'topic': 'Android', 'objective': '完成一个待办应用', 'start_date': '2026-12-31', 'days': 2, 'daily_minutes': 45}
MODEL_PLAN = {
    'name': 'Android 两天入门', 'goal': '理解界面与状态，完成练习', 'sections': ['界面', '状态'],
    'tasks': [
        {'day_number': 1, 'section_index': 0, 'title': '创建界面', 'minutes': 45, 'notes': '完成一个按钮界面'},
        {'day_number': 2, 'section_index': 1, 'title': '保存状态', 'minutes': 30, 'notes': '练习状态更新'},
    ],
}


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    with TestClient(app, raise_server_exceptions=False) as client:
        client.headers['x-local-token'] = app.state.local_token
        yield client
    app.state.database.dispose()


def model_transport(monkeypatch, handler):
    def factory(**kwargs):
        assert kwargs['trust_env'] is False
        assert kwargs['follow_redirects'] is False
        return REAL_CLIENT(transport=httpx.MockTransport(handler), **kwargs)
    monkeypatch.setattr(ollama.httpx, 'Client', factory)


def generate_draft(client, monkeypatch, plan=None):
    assert client.put('/api/v1/ai/ollama/settings', json=CONFIG).status_code == 200
    model_transport(monkeypatch, lambda request: httpx.Response(200, json={'done': True, 'message': {'content': json.dumps(plan or MODEL_PLAN)}}))
    response = client.post('/api/v1/ai/learning/generate', json=REQUIREMENTS)
    assert response.status_code == 200, response.text
    return response.json()


def test_settings_defaults_and_persisted_local_configuration(client):
    assert client.get('/api/v1/ai/ollama/settings').json() == {'base_url': 'http://127.0.0.1:11434', 'model': ''}
    assert client.put('/api/v1/ai/ollama/settings', json=CONFIG).status_code == 200
    assert client.get('/api/v1/ai/ollama/settings').json() == CONFIG
    settings = client.app.state.settings
    restarted = create_app(settings)
    try:
        with TestClient(restarted) as other:
            assert other.get('/api/v1/ai/ollama/settings').json() == CONFIG
    finally:
        restarted.state.database.dispose()


@pytest.mark.parametrize('url', ['https://example.com', 'http://user:pass@localhost:11434', 'http://localhost:11434/path', 'http://localhost:99999'])
def test_local_provider_rejects_other_hosts_and_ambiguous_urls(client, url):
    assert client.put('/api/v1/ai/ollama/settings', json={**CONFIG, 'base_url': url}).status_code == 422
    assert client.post('/api/v1/ai/ollama/models', json={'base_url': url}).status_code == 422


def test_model_listing_uses_the_configured_local_endpoint(client, monkeypatch):
    def handler(request):
        assert str(request.url) == 'http://localhost:12345/api/tags'
        return httpx.Response(200, json={'models': [{'name': 'qwen2.5:3b'}, {'name': 'qwen2.5:3b'}, {'name': 'other'}]})
    model_transport(monkeypatch, handler)
    response = client.post('/api/v1/ai/ollama/models', json={'base_url': 'http://localhost:12345/'})
    assert response.json() == {'models': ['other', 'qwen2.5:3b']}


def test_generation_uses_structured_output_and_does_not_create_live_plans(client, monkeypatch):
    with client.app.state.database.session() as session:
        session.add(QuickNote(content='私人笔记：不要发送给模型'))
    client.put('/api/v1/ai/ollama/settings', json=CONFIG)
    def handler(request):
        body = json.loads(request.content)
        assert request.url.path == '/api/chat'
        assert body['model'] == CONFIG['model']
        assert body['stream'] is False and body['think'] is False
        assert body['format']['type'] == 'object'
        slots = body['format']['properties']['tasks']
        assert slots['minItems'] == slots['maxItems'] == 2
        assert [slot['properties']['day_number']['enum'] for slot in slots['prefixItems']] == [[1], [2]]
        assert [slot['properties']['section_index']['enum'] for slot in slots['prefixItems']] == [[0], [1]]
        assert body['format']['properties']['sections']['minItems'] == body['format']['properties']['sections']['maxItems'] == 2
        assert all(slot['properties']['minutes']['enum'] == list(range(1, 46)) for slot in slots['prefixItems'])
        assert json.loads(body['messages'][1]['content'])['topic'] == 'Android'
        assert '私人笔记' not in json.dumps(body, ensure_ascii=False)
        return httpx.Response(200, json={'message': {'content': json.dumps(MODEL_PLAN)}})
    model_transport(monkeypatch, handler)
    draft = client.post('/api/v1/ai/learning/generate', json=REQUIREMENTS).json()
    assert [task['plan_date'] for task in draft['plan']['tasks']] == ['2026-12-31', '2027-01-01']
    assert client.get('/api/v1/learning/goals').json() == []
    assert client.get('/api/v1/agenda?date=2026-12-31').json() == []
    assert client.get(f"/api/v1/ai/learning/drafts/{draft['id']}").json() == draft


@pytest.mark.parametrize('days,minutes', [(1, 5), (7, 45), (30, 480)])
def test_small_model_generation_constrains_every_requested_day_and_its_time_budget(monkeypatch, days, minutes):
    def handler(request):
        body = json.loads(request.content)
        slots = body['format']['properties']['tasks']
        assert slots['minItems'] == slots['maxItems'] == days
        assert len(slots['prefixItems']) == days
        assert [slot['properties']['day_number']['enum'][0] for slot in slots['prefixItems']] == list(range(1, days + 1))
        assert [slot['properties']['section_index']['enum'][0] for slot in slots['prefixItems']] == list(range(days))
        assert body['format']['properties']['sections']['minItems'] == body['format']['properties']['sections']['maxItems'] == days
        assert all(slot['properties']['minutes']['enum'] == list(range(1, minutes + 1)) for slot in slots['prefixItems'])
        assert len(body['messages'][0]['content']) < 1000  # Do not duplicate a 30-day schema into the prompt.
        result = {'name': '轻量模型计划', 'goal': '完成练习', 'sections': [f'阶段 {day}' for day in range(1, days + 1)],
                  'tasks': [{'day_number': day, 'section_index': day - 1, 'title': f'练习 {day}', 'minutes': minutes, 'notes': '动手练习'} for day in range(1, days + 1)]}
        return httpx.Response(200, json={'message': {'content': json.dumps(result)}})
    model_transport(monkeypatch, handler)
    request = ollama.LearningGenerateRequest(**{**REQUIREMENTS, 'days': days, 'daily_minutes': minutes})
    result = ollama.generate_learning_plan(ollama.OllamaSettings(**CONFIG), request)
    assert len(result.tasks) == days
    assert all(task.minutes == minutes for task in result.tasks)


def test_user_edited_draft_is_imported_once_and_visible_in_home_today_and_search(client, monkeypatch):
    draft = generate_draft(client, monkeypatch)
    draft['plan']['name'] = '我的 Android 计划'
    draft['plan']['tasks'][0]['title'] = '手动修改的任务'
    draft['plan']['tasks'][0]['minutes'] = 35
    endpoint = f"/api/v1/ai/learning/drafts/{draft['id']}/import"
    imported = client.post(endpoint, json=draft['plan'])
    assert imported.status_code == 201
    goal = imported.json()
    assert goal['name'] == '我的 Android 计划'
    assert goal['estimated_minutes'] == 65
    assert [item['name'] for item in goal['sections']] == MODEL_PLAN['sections']
    assert len(goal['tasks']) == 2
    assert goal['tasks'][0]['details'] == MODEL_PLAN['tasks'][0]['notes']
    assert client.post(endpoint, json=draft['plan']).json()['id'] == goal['id']
    assert len(client.get('/api/v1/learning/goals').json()) == 1
    today = client.get('/api/v1/agenda?date=2026-12-31').json()
    assert len(today) == 1 and today[0]['title'] == '手动修改的任务'
    assert '预计 35 分钟' in today[0]['notes']
    home = client.get('/api/v1/home?date=2026-12-31').json()
    assert home['stats']['total'] == 1 and home['summaries']['learning']['count'] == 1
    assert client.get('/api/v1/search?q=手动修改的任务').json()
    assert client.get('/api/v1/search?q=我的 Android 计划').json()
    client.delete(f"/api/v1/learning/goals/{goal['id']}")
    assert client.post(endpoint, json=draft['plan']).status_code == 409


@pytest.mark.parametrize('change', ['bad_section', 'missing_section', 'missing_day', 'over_budget', 'duplicate', 'blank_title'])
def test_invalid_model_results_are_rejected_without_any_draft_or_live_plan(client, monkeypatch, change):
    plan = deepcopy(MODEL_PLAN)
    if change == 'bad_section': plan['tasks'][0]['section_index'] = 99
    if change == 'missing_section': plan['sections'] = plan['sections'][:1]
    if change == 'missing_day': plan['tasks'] = plan['tasks'][:1]
    if change == 'over_budget': plan['tasks'][0]['minutes'] = 46
    if change == 'duplicate': plan['tasks'].append(deepcopy(plan['tasks'][0]))
    if change == 'blank_title': plan['tasks'][0]['title'] = '  '
    client.put('/api/v1/ai/ollama/settings', json=CONFIG)
    model_transport(monkeypatch, lambda request: httpx.Response(200, json={'message': {'content': json.dumps(plan)}}))
    assert client.post('/api/v1/ai/learning/generate', json=REQUIREMENTS).status_code == 502
    with client.app.state.database.session() as session:
        assert session.scalars(select(AILearningDraft)).all() == []
        assert session.scalars(select(LearningGoal)).all() == []


@pytest.mark.parametrize('failure,expected', [('offline', 503), ('timeout', 504), ('missing', 422), ('invalid_json', 502), ('redirect', 502)])
def test_provider_errors_are_actionable_and_create_no_live_plan(client, monkeypatch, failure, expected):
    client.put('/api/v1/ai/ollama/settings', json=CONFIG)
    def handler(request):
        if failure == 'offline': raise httpx.ConnectError('offline', request=request)
        if failure == 'timeout': raise httpx.ReadTimeout('timeout', request=request)
        if failure == 'missing': return httpx.Response(404)
        if failure == 'redirect': return httpx.Response(302, headers={'Location': 'https://example.com'})
        return httpx.Response(200, content='invalid')
    model_transport(monkeypatch, handler)
    response = client.post('/api/v1/ai/learning/generate', json=REQUIREMENTS)
    assert response.status_code == expected
    assert isinstance(response.json()['detail'], str)
    assert client.get('/api/v1/learning/goals').json() == []


def test_import_validation_and_transaction_failure_leave_no_partial_plan(client, monkeypatch):
    draft = generate_draft(client, monkeypatch)
    invalid = deepcopy(draft['plan'])
    invalid['tasks'][0]['plan_date'] = '2027-02-01'
    endpoint = f"/api/v1/ai/learning/drafts/{draft['id']}/import"
    assert client.post(endpoint, json=invalid).status_code == 422
    original_flush = Session.flush
    def fail_on_agenda(self, *args, **kwargs):
        if any(isinstance(item, AgendaItem) for item in self.new):
            raise RuntimeError('simulated persistence failure')
        return original_flush(self, *args, **kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(Session, 'flush', fail_on_agenda)
        assert client.post(endpoint, json=draft['plan']).status_code == 500
    assert client.get('/api/v1/learning/goals').json() == []
    assert client.get('/api/v1/agenda?date=2026-12-31').json() == []
    assert client.post(endpoint, json=draft['plan']).status_code == 201


def test_missing_config_and_write_token_do_not_generate_or_import(client):
    assert client.post('/api/v1/ai/learning/generate', json=REQUIREMENTS).status_code == 422
    assert client.post('/api/v1/ai/learning/drafts/missing/import', json={}).status_code == 422
    client.headers.pop('x-local-token')
    assert client.put('/api/v1/ai/ollama/settings', json=CONFIG).status_code == 403
    assert client.post('/api/v1/ai/learning/generate', json=REQUIREMENTS).status_code == 403


def test_upgrade_from_0003_preserves_existing_learning_goals_and_adds_drafts(tmp_path):
    path = tmp_path / 'existing.db'
    command.upgrade(migration_config(path), '0003')
    database = Database(path)
    with database.session() as session:
        session.add(LearningGoal(id='keep', name='保留的计划'))
    with database.engine.begin() as connection:
        connection.exec_driver_sql('DROP TABLE ai_learning_drafts')
    database.dispose()
    migrate_database(path)
    database = Database(path)
    try:
        with database.session() as session:
            assert session.get(LearningGoal, 'keep').name == '保留的计划'
            assert session.scalars(select(AILearningDraft)).all() == []
    finally:
        database.dispose()
