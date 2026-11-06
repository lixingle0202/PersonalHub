from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3

import httpx
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.public import DAILY_GENERATIONS, SHARED_MODEL_CONCURRENCY, create_public_app
from app.services import ollama


HOST = "https://hub.example.test"
PASSWORD = "long-private-password"
PLAN = {
    "name": "两天学习计划", "goal": "学会界面和状态", "sections": ["界面", "状态"],
    "tasks": [
        {"day_number": 1, "section_index": 0, "title": "画出界面", "minutes": 45, "notes": "学习布局15分钟；练习按钮点击25分钟；产出：可运行的按钮界面；验收5分钟：点击按钮后文字改变。"},
        {"day_number": 2, "section_index": 1, "title": "保存状态", "minutes": 45, "notes": "学习状态保存15分钟；练习待办列表25分钟；产出：能保留输入的待办页；验收5分钟：重建页面后内容不丢失。"},
    ],
}
REQUIREMENTS = {"topic": "Android", "objective": "完成练习", "start_date": "2026-12-31",
                "days": 2, "daily_minutes": 45}


def test_public_assets_are_compressed_and_cached_without_account_lookups(tmp_path, monkeypatch):
    from app import public as public_module
    root = tmp_path / 'frontend'
    (root / 'assets').mkdir(parents=True)
    (root / 'index.html').write_text('<html>PersonalHub</html>', encoding='utf-8')
    script = 'console.log("PersonalHub");\n' * 500
    (root / 'assets' / 'app-a1b2c3.js').write_bytes(script.encode('utf-8'))
    monkeypatch.setattr(public_module, 'frontend_dist_path', lambda: root)
    app = create_public_app(tmp_path / 'public')
    def no_auth_lookup(*args):
        raise AssertionError('Public assets must not touch the account database')
    monkeypatch.setattr(app.store, 'user_for', no_auth_lookup)
    with TestClient(app, base_url=HOST) as browser:
        response = browser.get('/assets/app-a1b2c3.js', headers={'Accept-Encoding': 'gzip'})
        assert response.text == script
        assert response.headers['content-encoding'] == 'gzip'
        assert 'immutable' in response.headers['cache-control']
        assert int(response.headers['content-length']) < len(script) / 4
        assert browser.get('/learning').headers['cache-control'] == 'no-store'
        missing = browser.get('/assets/old-missing.js')
        assert missing.status_code == 404
        assert missing.headers['cache-control'] == 'no-store'


def register(client: TestClient, name: str) -> str:
    response = client.post("/api/v1/public/register", json={"username": name, "password": PASSWORD})
    assert response.status_code == 200, response.text
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "Secure" in response.headers["set-cookie"]
    assert "SameSite=strict" in response.headers["set-cookie"]
    bootstrap = client.get("/api/v1/bootstrap")
    assert bootstrap.status_code == 200, bootstrap.text
    assert bootstrap.json()["public_mode"] is True
    assert bootstrap.json()["database_path"] == "独立个人空间"
    return bootstrap.json()["local_token"]


def test_public_api_requires_login_and_never_mounts_owner_data(tmp_path):
    private = create_app(Settings(data_root=tmp_path / "owner"))
    with TestClient(private) as owner:
        owner.post("/api/v1/learning/goals", json={"name": "主人私人计划"},
                   headers={"x-local-token": private.state.local_token})
    private.state.database.dispose()
    original = (tmp_path / "owner" / "data" / "personal_data.db").read_bytes()

    public = create_public_app(tmp_path / "shared")
    with TestClient(public, base_url=HOST) as stranger:
        for path in ("/api/v1/bootstrap", "/api/v1/learning/goals", "/api/v1/search?q=私人"):
            assert stranger.get(path).status_code == 401
        assert stranger.post("/api/v1/learning/goals", json={"name": "越权"}).status_code == 401
        token = register(stranger, "alice")
        assert stranger.get("/api/v1/learning/goals").json() == []
        assert stranger.get("/api/v1/ai/ollama/settings").json()["model"] == "qwen2.5:1.5b"
        assert stranger.put("/api/v1/ai/ollama/settings", json={"base_url": "http://127.0.0.1:9999", "model": "bad"},
                            headers={"x-local-token": token}).status_code == 403
        assert stranger.post("/api/v1/ai/ollama/models", json={"base_url": "http://127.0.0.1:9999"},
                             headers={"x-local-token": token}).status_code == 403
        assert "主人私人计划" not in stranger.get("/api/v1/search?q=私人").text
        traversal = stranger.get("/%2e%2e%5c%2e%2e%5cREADME.md")
        assert traversal.status_code == 200
        assert traversal.headers["content-type"].startswith("text/html")
    assert (tmp_path / "owner" / "data" / "personal_data.db").read_bytes() == original


def test_two_accounts_get_independent_plans_backups_and_write_tokens(tmp_path):
    public = create_public_app(tmp_path / "shared")
    with TestClient(public, base_url=HOST) as alice, TestClient(public, base_url=HOST) as bob:
        alice_token = register(alice, "alice")
        bob_token = register(bob, "bob")
        assert alice_token != bob_token
        created = alice.post("/api/v1/learning/goals", json={"name": "Alice 的学习"},
                             headers={"x-local-token": alice_token})
        assert created.status_code == 201, created.text
        assert bob.get("/api/v1/learning/goals").json() == []
        assert bob.get("/api/v1/search?q=Alice").json() == []
        assert bob.get("/api/v1/learning/goals/" + created.json()["id"]).status_code == 404
        assert bob.post("/api/v1/learning/goals", json={"name": "错误令牌"},
                        headers={"x-local-token": alice_token}).status_code == 403
        assert bob.post("/api/v1/learning/goals", json={"name": "Bob 的学习"},
                        headers={"x-local-token": bob_token}).status_code == 201
        meal = alice.post("/api/v1/diet/meals", json={
            "meal_date": "2026-12-31", "meal_type": "dinner", "custom_name": "Alice 的晚餐",
        }, headers={"x-local-token": alice_token})
        assert meal.status_code == 201, meal.text
        meal_list = "/api/v1/diet/meals?start_date=2026-12-31&end_date=2026-12-31"
        assert len(alice.get(meal_list).json()) == 1
        assert bob.get(meal_list).json() == []
        assert bob.get("/api/v1/search?q=Alice").json() == []
        assert alice.get("/api/v1/home?date=2026-12-31").json()["stats"]["total"] >= 1
        alice_backup = alice.post("/api/v1/backups", headers={"x-local-token": alice_token})
        assert alice_backup.status_code == 201
        assert bob.get("/api/v1/backups").json() == []
        assert alice.get("/api/v1/learning/goals").json()[0]["name"] == "Alice 的学习"
        assert bob.get("/api/v1/learning/goals").json()[0]["name"] == "Bob 的学习"


def test_login_logout_password_storage_session_restart_and_csrf(tmp_path):
    root = tmp_path / "shared"
    public = create_public_app(root)
    with TestClient(public, base_url=HOST) as alice:
        register(alice, "alice")
        assert alice.post("/api/v1/learning/goals", json={"name": "跨站"},
                          headers={"origin": "https://attacker.example"}).status_code == 403
        assert alice.post("/api/v1/learning/goals", json={"name": "跨站"},
                          headers={"sec-fetch-site": "cross-site"}).status_code == 403
        assert alice.post("/api/v1/public/register", json={"username": "alice", "password": PASSWORD}).status_code == 409
        assert alice.post("/api/v1/public/logout").status_code == 200
        assert alice.get("/api/v1/bootstrap").status_code == 401
        assert alice.post("/api/v1/public/login", json={"username": "alice", "password": "wrong-password"}).status_code == 401
        assert alice.post("/api/v1/public/login", json={"username": "alice", "password": PASSWORD}).status_code == 200
        assert alice.get("/api/v1/bootstrap").status_code == 200
        with sqlite3.connect(root / "accounts.sqlite3") as database:
            stored = database.execute("SELECT password_hash FROM accounts WHERE username='alice'").fetchone()[0]
        assert stored != PASSWORD.encode()
        assert len(stored) == hashlib.sha256().digest_size
        cookie = alice.cookies.get("personalhub_public_session")
    restarted = create_public_app(root)
    with TestClient(restarted, base_url=HOST) as browser:
        browser.cookies.set("personalhub_public_session", cookie, domain="hub.example.test")
        assert browser.get("/api/v1/bootstrap").status_code == 200
        assert browser.get("/api/v1/public/me").json()["username"] == "alice"


def test_shared_model_generates_only_in_signed_in_users_space_and_limits_usage(tmp_path, monkeypatch):
    real_client = httpx.Client
    requests = []

    def transport(request):
        requests.append(request)
        assert request.url.host == "127.0.0.1"
        assert request.url.port == 11434
        body = json.loads(request.content)
        assert body["model"] == "qwen2.5:1.5b"
        return httpx.Response(200, json={"message": {"content": json.dumps(PLAN)}})

    monkeypatch.setattr(ollama.httpx, "Client", lambda **kwargs: real_client(
        transport=httpx.MockTransport(transport), **kwargs))
    public = create_public_app(tmp_path / "shared")
    with TestClient(public, base_url=HOST) as alice, TestClient(public, base_url=HOST) as bob:
        alice_token = register(alice, "alice")
        bob_token = register(bob, "bob")
        assert alice.post("/api/v1/ai/learning/generate", json=REQUIREMENTS).status_code == 403
        drafts = []
        for _ in range(DAILY_GENERATIONS):
            result = alice.post("/api/v1/ai/learning/generate", json=REQUIREMENTS,
                                headers={"x-local-token": alice_token})
            assert result.status_code == 200, result.text
            drafts.append(result.json()["id"])
        assert alice.post("/api/v1/ai/learning/generate", json=REQUIREMENTS,
                          headers={"x-local-token": alice_token}).status_code == 429
        assert bob.get("/api/v1/ai/learning/drafts/" + drafts[0]).status_code == 404
        assert bob.post("/api/v1/ai/learning/generate", json=REQUIREMENTS,
                        headers={"x-local-token": bob_token}).status_code == 200
        assert alice.get("/api/v1/learning/goals").json() == []
        assert len(requests) == DAILY_GENERATIONS + 1


def test_busy_shared_model_is_retryable_and_does_not_use_daily_quota(tmp_path):
    root = tmp_path / 'shared'
    public = create_public_app(root)
    with TestClient(public, base_url=HOST) as alice:
        token = register(alice, 'alice')
        for _ in range(SHARED_MODEL_CONCURRENCY):
            asyncio.run(public.model_gate.acquire())
        try:
            for endpoint in ['/api/v1/ai/learning/generate', '/api/v1/ai/diet/generate']:
                response = alice.post(endpoint, json=REQUIREMENTS, headers={'x-local-token': token})
                assert response.status_code == 429
                assert response.json()['code'] == 'model_busy'
                assert response.headers['Retry-After'] == '3'
            with sqlite3.connect(root / 'accounts.sqlite3') as database:
                assert database.execute('SELECT count(*) FROM model_usage').fetchone()[0] == 0
        finally:
            for _ in range(SHARED_MODEL_CONCURRENCY):
                public.model_gate.release()


def test_visitor_model_uses_browser_result_without_host_inference_and_keeps_drafts_private(tmp_path, monkeypatch):
    def host_model_must_not_run(*_args, **_kwargs):
        raise AssertionError('visitor model must run in the browser, not on the host')

    monkeypatch.setattr(ollama, 'ollama_request', host_model_must_not_run)
    root = tmp_path / 'shared'
    public = create_public_app(root)
    with TestClient(public, base_url=HOST) as alice, TestClient(public, base_url=HOST) as bob:
        alice_token = register(alice, 'alice')
        register(bob, 'bob')
        prepare = '/api/v1/ai/learning/visitor/prepare'
        save = '/api/v1/ai/learning/visitor/draft'
        assert alice.post(prepare, json=REQUIREMENTS).status_code == 403
        prepared = alice.post(prepare, json=REQUIREMENTS, headers={'x-local-token': alice_token})
        assert prepared.status_code == 200, prepared.text
        assert prepared.json()['format']['properties']['tasks']['minItems'] == 2
        assert '私人笔记' not in json.dumps(prepared.json(), ensure_ascii=False)
        assert 'model' not in prepared.json()
        assert alice.post(save, json={'requirements': REQUIREMENTS, 'content': json.dumps(PLAN)}).status_code == 403
        invalid = {**PLAN, 'tasks': PLAN['tasks'][:1]}
        rejected = alice.post(save, json={'requirements': REQUIREMENTS, 'content': json.dumps(invalid)},
                              headers={'x-local-token': alice_token})
        assert rejected.status_code == 502
        draft = alice.post(save, json={'requirements': REQUIREMENTS, 'content': json.dumps(PLAN)},
                           headers={'x-local-token': alice_token})
        assert draft.status_code == 200, draft.text
        draft_id = draft.json()['id']
        assert draft.json()['plan']['tasks'][1]['plan_date'] == '2027-01-01'
        assert bob.get(f'/api/v1/ai/learning/drafts/{draft_id}').status_code == 404
        assert alice.get('/api/v1/learning/goals').json() == []
        imported = alice.post(f'/api/v1/ai/learning/drafts/{draft_id}/import', json=draft.json()['plan'],
                              headers={'x-local-token': alice_token})
        assert imported.status_code == 201, imported.text
        assert alice.get('/api/v1/learning/goals').json()[0]['id'] == imported.json()['id']
        assert bob.get('/api/v1/learning/goals').json() == []
    with sqlite3.connect(root / 'accounts.sqlite3') as database:
        assert database.execute('SELECT count(*) FROM model_usage').fetchone()[0] == 0
