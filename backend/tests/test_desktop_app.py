import json
import time
import pytest

from fastapi.testclient import TestClient

from app.desktop_launcher import DesktopHub, desktop_settings
from app.services import ollama


def register(browser, name):
    result = browser.post('/api/v1/public/register', json={'username': name, 'password': 'desktop-test-password'})
    assert result.status_code == 200, result.text
    assert 'Secure' not in result.headers['set-cookie']
    data = browser.get('/api/v1/bootstrap').json()
    assert data['desktop_mode'] and data['public_mode']
    browser.headers['x-local-token'] = data['local_token']
    return data


def wait_job(browser, result):
    assert result.status_code == 202, result.text
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        job = browser.get('/api/v1/ai/shared/jobs/' + result.json()['job_id']).json()
        if job['state'] in {'completed', 'failed', 'cancelled'}:
            assert job['state'] == 'completed', job
            return job['result']
        time.sleep(.01)
    raise AssertionError('Desktop generation never completed')


def test_desktop_login_account_isolation_model_configuration_and_restart(tmp_path):
    root = tmp_path / 'desktop'
    app = DesktopHub(root, 'http://127.0.0.1:11480')
    with TestClient(app, base_url='http://127.0.0.1:8770') as alice:
        assert alice.get('/health').json()['mode'] == 'desktop'
        denied = alice.get('/api/v1/bootstrap')
        assert denied.status_code == 401 and denied.json()['desktop_mode']
        assert alice.get('/api/v1/desktop/ai/status').status_code == 401
        register(alice, 'alice')
        config = alice.get('/api/v1/ai/ollama/settings').json()
        assert config == {'base_url': 'http://127.0.0.1:11480', 'model': 'qwen2.5:1.5b'}
        goal = alice.post('/api/v1/learning/goals', json={'name': '本机独立学习计划'}).json()
        with TestClient(app, base_url='http://127.0.0.1:8770') as bob:
            register(bob, 'bobby')
            assert bob.get('/api/v1/learning/goals').json() == []
            assert bob.get('/api/v1/learning/goals/' + goal['id']).status_code == 404
        assert alice.post('/api/v1/public/logout').status_code == 200
        assert alice.get('/api/v1/bootstrap').status_code == 401
    restarted = DesktopHub(root, 'http://127.0.0.1:11481')
    with TestClient(restarted, base_url='http://127.0.0.1:8770') as alice:
        assert alice.post('/api/v1/public/login', json={'username': 'alice', 'password': 'desktop-test-password'}).status_code == 200
        assert alice.get('/api/v1/learning/goals').json()[0]['id'] == goal['id']
        assert alice.get('/api/v1/ai/ollama/settings').json()['base_url'].endswith(':11481')


@pytest.mark.parametrize('custom', [False, True])
def test_both_ai_features_complete_in_desktop_background_jobs(tmp_path, monkeypatch, custom):
    calls = []
    def inference(settings, path, payload):
        calls.append((settings.base_url, settings.model))
        if 'theme' in json.loads(payload['messages'][1]['content']):
            content = {'name': '三餐示例', 'description': '均衡一日菜单', 'meals': [
                {'day_number': 1, 'meal_type': kind, 'name': name, 'estimated_kcal': kcal}
                for kind, name, kcal in [('breakfast', '牛奶燕麦', 350), ('lunch', '番茄鸡蛋米饭', 600), ('dinner', '青菜豆腐面', 550)]
            ]}
        else:
            content = {'name': 'CSV实操', 'goal': '读写CSV', 'sections': ['文件处理'], 'tasks': [
                {'day_number': 1, 'section_index': 0, 'minutes': 45, 'title': '读取并写回CSV文件',
                 'notes': '阅读CSV示例15分钟；编写读写脚本25分钟；产出：两行数据文件和脚本；验收5分钟：读回数据并逐项核对字段。'}]}
        return {'message': {'content': json.dumps(content)}, 'done': True}
    monkeypatch.setattr(ollama, 'ollama_request', inference)
    # diet_ai imports this function directly.
    monkeypatch.setattr('app.api.diet_ai.ollama_request', inference)
    app = DesktopHub(tmp_path / 'desktop', 'http://127.0.0.1:11480')
    async def names(url):
        return ['alternative:7b']
    monkeypatch.setattr(app, '_model_names', names)
    with TestClient(app, base_url='http://127.0.0.1:8770') as browser:
        register(browser, 'student')
        if custom:
            assert browser.put('/api/v1/desktop/ai/settings', json={
                'source': 'local', 'base_url': 'http://127.0.0.1:11434', 'model': 'alternative:7b',
            }).status_code == 200
        learning = wait_job(browser, browser.post('/api/v1/ai/learning/generate', json={
            'topic': 'Python', 'objective': '读写CSV', 'start_date': '2026-11-06', 'days': 1, 'daily_minutes': 45,
        }, headers={'Prefer': 'respond-async'}))
        assert learning['id'] and len(learning['plan']['tasks']) == 1
        assert browser.post(f"/api/v1/ai/learning/drafts/{learning['id']}/import", json=learning['plan']).status_code == 201
        diet = wait_job(browser, browser.post('/api/v1/ai/diet/generate', json={
            'theme': '一日三餐', 'days': 1, 'preferences': '',
        }, headers={'Prefer': 'respond-async'}))
        assert len(diet['plan']['meals']) == 3
        expected = ('http://127.0.0.1:11434', 'alternative:7b') if custom else ('http://127.0.0.1:11480', 'qwen2.5:1.5b')
        assert calls == [expected] * 2
        user_id = next(iter(app.user_apps))
        assert all(app.store.reserve_generation(user_id) for _ in range(15))


def test_desktop_data_is_separate_from_legacy_owner_data(tmp_path, monkeypatch):
    monkeypatch.setenv('LOCALAPPDATA', str(tmp_path))
    monkeypatch.delenv('PERSONAL_HUB_DESKTOP_DATA_DIR', raising=False)
    assert desktop_settings().data_root == (tmp_path / 'PersonalHubDesktop').resolve()


def test_model_switch_is_verified_isolated_persisted_and_resettable(tmp_path, monkeypatch):
    root = tmp_path / 'desktop'
    async def names(url):
        return ['custom:7b', 'custom:3b'] if url.endswith(':11434') else ['qwen2.5:1.5b']
    monkeypatch.setattr(DesktopHub, '_model_names', lambda self, url: names(url))
    custom = {'source': 'local', 'base_url': 'http://127.0.0.1:11434', 'model': 'custom:7b'}
    with TestClient(DesktopHub(root, 'http://127.0.0.1:11480'), base_url='http://127.0.0.1:8770') as alice:
        assert alice.put('/api/v1/desktop/ai/settings', json=custom).status_code == 401
        register(alice, 'alice')
        assert alice.post('/api/v1/desktop/ai/models', json={'base_url': custom['base_url']}).json()['models'] == ['custom:7b', 'custom:3b']
        assert alice.put('/api/v1/desktop/ai/settings', json=custom).json() == custom
        assert alice.get('/api/v1/desktop/ai/status').json()['model'] == 'custom:7b'
        assert alice.put('/api/v1/desktop/ai/settings', json={**custom, 'model': 'missing'}).status_code == 422
        assert alice.get('/api/v1/desktop/ai/settings').json() == custom
        with TestClient(alice.app, base_url='http://127.0.0.1:8770') as bob:
            register(bob, 'bobby')
            assert bob.get('/api/v1/desktop/ai/settings').json()['source'] == 'builtin'
    with TestClient(DesktopHub(root, 'http://127.0.0.1:11481'), base_url='http://127.0.0.1:8770') as alice:
        alice.post('/api/v1/public/login', json={'username': 'alice', 'password': 'desktop-test-password'})
        alice.headers['x-local-token'] = alice.get('/api/v1/bootstrap').json()['local_token']
        assert alice.get('/api/v1/desktop/ai/settings').json() == custom
        assert alice.get('/api/v1/ai/ollama/settings').json()['model'] == 'custom:7b'
        reset = alice.put('/api/v1/desktop/ai/settings', json={'source': 'builtin'})
        assert reset.status_code == 200
        assert reset.json() == {'source': 'builtin', 'base_url': 'http://127.0.0.1:11481', 'model': 'qwen2.5:1.5b'}


def test_model_switch_validation_permissions_and_busy_state(tmp_path, monkeypatch):
    app = DesktopHub(tmp_path / 'desktop', 'http://127.0.0.1:11480')
    calls = []
    async def names(url):
        calls.append(url)
        return ['custom:7b']
    monkeypatch.setattr(app, '_model_names', names)
    custom = {'source': 'local', 'base_url': 'http://127.0.0.1:11434', 'model': 'custom:7b'}
    with TestClient(app, base_url='http://127.0.0.1:8770') as browser:
        register(browser, 'student')
        assert browser.put('/api/v1/desktop/ai/settings', json=custom, headers={'X-Local-Token': 'wrong'}).status_code == 403
        assert browser.put('/api/v1/desktop/ai/settings', json=custom, headers={'Origin': 'https://evil.example'}).status_code == 403
        assert browser.post('/api/v1/desktop/ai/models', json={'base_url': 'https://external.example'}).status_code == 422
        assert browser.put('/api/v1/desktop/ai/settings', json={**custom, 'base_url': 'http://192.168.1.1:11434'}).status_code == 422
        assert calls == []
        user_id = next(iter(app.user_apps))
        app.generating_users.add(user_id)
        assert browser.put('/api/v1/desktop/ai/settings', json=custom).status_code == 409
        app.generating_users.clear()
        async def unavailable(url):
            from fastapi import HTTPException
            raise HTTPException(503, '服务未启动')
        monkeypatch.setattr(app, '_model_names', unavailable)
        assert browser.put('/api/v1/desktop/ai/settings', json=custom).status_code == 503
        status = browser.get('/api/v1/desktop/ai/status').json()
        assert not status['ready'] and status['source'] == 'builtin'
        assert browser.get('/api/v1/ai/ollama/settings').json()['model'] == 'qwen2.5:1.5b'
