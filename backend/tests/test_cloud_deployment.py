from __future__ import annotations

import json
import sqlite3
import tarfile

from fastapi import HTTPException
from fastapi.testclient import TestClient
import httpx
import pytest

from app.cloud import CloudHub, create_cloud_app
from app.cloud_backup import backup_cloud
from app.services import cloud_model, ollama
from app.services.cloud_model import BailianSettings, bailian_request


HOST = 'https://203.0.113.10'
SECRET = 'test-server-only-api-key'
PASSWORD = 'cloud-demo-password'
PLAN = {
    'name': 'Python 列表入门', 'goal': '掌握列表索引', 'sections': ['列表基础'],
    'tasks': [{'day_number': 1, 'section_index': 0, 'title': '练习列表索引', 'minutes': 45,
               'notes': '学习 Python 列表索引15分钟；练习索引取值25分钟；产出：3个正确的索引示例；验收5分钟：独立写出并运行3个索引表达式。'}],
}
REQUIREMENTS = {'topic': 'Python', 'objective': '掌握列表索引', 'start_date': '2026-12-01', 'days': 1, 'daily_minutes': 45}


def settings(**overrides):
    return BailianSettings(**{'model': 'free-trial-model', 'api_key': SECRET, 'enabled': True,
                              'free_only_confirmed': True, **overrides})


def mock_provider(monkeypatch, handler):
    original = httpx.Client
    monkeypatch.setattr(cloud_model.httpx, 'Client', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))


def provider_reply(content):
    return httpx.Response(200, json={'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(content)}}]})


def register(client, username='alice'):
    response = client.post('/api/v1/public/register', json={'username': username, 'password': PASSWORD})
    assert response.status_code == 200, response.text
    assert 'Secure' in response.headers['set-cookie']
    return {'X-Local-Token': client.get('/api/v1/bootstrap').json()['local_token']}


@pytest.mark.parametrize('overrides', [
    {'api_key': ''}, {'free_only_confirmed': False},
    {'base_url': 'http://dashscope.aliyuncs.com/compatible-mode/v1'},
    {'base_url': 'https://example.com/compatible-mode/v1'},
    {'base_url': 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'},
    {'base_url': 'https://dashscope.aliyuncs.com/compatible-mode/v1?api_key=secret'},
])
def test_cloud_trial_requires_explicit_enablement_and_beijing_endpoint(overrides):
    with pytest.raises(ValueError):
        settings(**overrides)


def test_cloud_model_translates_schema_and_keeps_server_model_and_secret_out_of_body(monkeypatch):
    seen = []
    def inference(request):
        body = json.loads(request.content)
        seen.append(body)
        assert request.url == 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions'
        assert request.headers['authorization'] == 'Bearer ' + SECRET
        assert body['model'] == 'free-trial-model' and body['stream'] is False
        assert body['response_format'] == {'type': 'json_object'}
        assert body['enable_thinking'] is False
        assert 'JSON Schema' in body['messages'][0]['content']
        assert SECRET not in request.content.decode()
        return provider_reply(PLAN)
    mock_provider(monkeypatch, inference)
    payload = {'model': 'unapproved-model', **ollama.learning_chat_payload(ollama.LearningGenerateRequest(**REQUIREMENTS))}
    original = json.dumps(payload)
    model = settings(base_url='https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
    result = ollama.ollama_request(model, '/api/chat', payload)
    assert json.loads(result['message']['content']) == PLAN and result['done'] is True
    assert json.dumps(payload) == original and len(seen) == 1
    assert SECRET not in repr(model) and SECRET not in json.dumps(model.public_view())


def test_cloud_accounts_generate_learning_and_diet_and_sync_saved_plans_across_devices(tmp_path, monkeypatch):
    calls = []
    def inference(request):
        body = json.loads(request.content)
        calls.append(body)
        if '主题' in body['messages'][0]['content'] and '菜' in body['messages'][0]['content']:
            return provider_reply({'name': '均衡餐单', 'description': '一日三餐', 'meals': [
                {'day_number': 1, 'meal_type': kind, 'name': name, 'estimated_kcal': kcal}
                for kind, name, kcal in [('breakfast', '牛奶燕麦', 350), ('lunch', '番茄鸡蛋面', 550), ('dinner', '鱼肉蔬菜饭', 500)]
            ]})
        return provider_reply(PLAN)
    mock_provider(monkeypatch, inference)
    app = CloudHub(tmp_path / 'cloud', settings())
    with TestClient(app, base_url=HOST) as alice:
        assert alice.get('/api/v1/bootstrap').status_code == 401
        headers = register(alice)
        config = alice.get('/api/v1/ai/ollama/settings')
        assert config.json()['provider'] == 'bailian' and SECRET not in config.text
        generated = alice.post('/api/v1/ai/learning/generate', json=REQUIREMENTS, headers=headers)
        assert generated.status_code == 200, generated.text
        assert alice.get('/api/v1/learning/goals').json() == []
        preview = generated.json()
        imported = alice.post('/api/v1/ai/learning/drafts/' + preview['id'] + '/import', json=preview['plan'], headers=headers)
        assert imported.status_code == 201, imported.text
        saved_id = imported.json()['id']
        diet = alice.post('/api/v1/ai/diet/generate', json={'theme': '均衡', 'days': 1}, headers=headers)
        assert diet.status_code == 200, diet.text
        assert len(diet.json()['plan']['meals']) == 3
    with TestClient(app, base_url=HOST) as another_device:
        assert another_device.post('/api/v1/public/login', json={'username': 'alice', 'password': PASSWORD}).status_code == 200
        assert another_device.get('/api/v1/learning/goals').json()[0]['id'] == saved_id
        assert SECRET not in another_device.get('/api/v1/home').text
    with TestClient(app, base_url=HOST) as bob:
        register(bob, 'bob')
        assert bob.get('/api/v1/learning/goals').json() == []
    assert len(calls) == 2
    for database in (tmp_path / 'cloud').rglob('*.db'):
        assert SECRET.encode() not in database.read_bytes()


def test_disabled_cloud_ai_keeps_manual_features_and_never_calls_provider(tmp_path, monkeypatch):
    monkeypatch.setenv('PERSONAL_HUB_PUBLIC_DATA_DIR', str(tmp_path / 'disabled'))
    monkeypatch.delenv('PERSONAL_HUB_CLOUD_AI_ENABLED', raising=False)
    monkeypatch.delenv('PERSONAL_HUB_FREE_ONLY_CONFIRMED', raising=False)
    monkeypatch.delenv('DASHSCOPE_API_KEY', raising=False)
    app = create_cloud_app()
    def unexpected(_request):
        pytest.fail('Disabled AI must not make a billable request')
    mock_provider(monkeypatch, unexpected)
    with TestClient(app, base_url=HOST) as client:
        headers = register(client)
        response = client.post('/api/v1/agenda', json={'title': '手动学习计划', 'plan_date': '2026-12-01'}, headers=headers)
        assert response.status_code == 201, response.text
        ai = client.post('/api/v1/ai/learning/generate', json=REQUIREMENTS, headers=headers)
        assert ai.status_code == 503 and '尚未开通' in ai.json()['detail']


@pytest.mark.parametrize('status,code,phrase', [
    (403, 'AllocationQuota.FreeTierOnly', '免费额度'),
    (401, 'invalid_api_key', '认证或权限'), (429, 'rate_limit', '请求较多'),
    (500, 'internal', '暂时不可用'),
])
def test_provider_errors_are_safe_and_do_not_create_or_charge_successes(tmp_path, monkeypatch, status, code, phrase):
    calls = []
    def inference(request):
        calls.append(request)
        return httpx.Response(status, json={'error': {'code': code, 'message': SECRET}})
    mock_provider(monkeypatch, inference)
    app = CloudHub(tmp_path / 'cloud', settings())
    with TestClient(app, base_url=HOST) as client:
        headers = register(client)
        for _ in range(13):
            response = client.post('/api/v1/ai/learning/generate', json=REQUIREMENTS, headers=headers)
            assert response.status_code in (502, 503) and phrase in response.json()['detail']
            assert SECRET not in response.text
        assert client.get('/api/v1/learning/goals').json() == []
    assert len(calls) == 13
    for database in (tmp_path / 'cloud').glob('users/*/data/personal_data.db'):
        with sqlite3.connect(database) as connection:
            assert connection.execute('SELECT count(*) FROM ai_learning_drafts').fetchone()[0] == 0


@pytest.mark.parametrize('reply', [{}, {'choices': []}, {'choices': [{'finish_reason': 'length', 'message': {'content': '{}'}}]}])
def test_cloud_rejects_incomplete_output_without_silently_retrying(monkeypatch, reply):
    calls = []
    def inference(request):
        calls.append(request)
        return httpx.Response(200, json=reply)
    mock_provider(monkeypatch, inference)
    with pytest.raises(HTTPException) as failure:
        bailian_request(settings(), '/api/chat', ollama.learning_chat_payload(ollama.LearningGenerateRequest(**REQUIREMENTS)))
    assert failure.value.status_code == 502 and len(calls) == 1


def test_cloud_backup_restores_accounts_and_records_without_server_key(tmp_path):
    root = tmp_path / 'original'
    app = CloudHub(root, BailianSettings())
    with TestClient(app, base_url=HOST) as client:
        headers = register(client)
        created = client.post('/api/v1/quick-notes', json={'content': '保留三个月试运行记录'}, headers=headers)
        assert created.status_code == 201
    archive = backup_cloud(root, tmp_path / 'backups')
    restored = tmp_path / 'restored'
    with tarfile.open(archive) as backup:
        assert 'accounts.sqlite3' in backup.getnames()
        assert all('.env' not in name for name in backup.getnames())
        backup.extractall(restored, filter='data')
    fresh = CloudHub(restored, BailianSettings())
    with TestClient(fresh, base_url=HOST) as client:
        assert client.post('/api/v1/public/login', json={'username': 'alice', 'password': PASSWORD}).status_code == 200
        assert client.get('/api/v1/quick-notes').json()[0]['content'] == '保留三个月试运行记录'
