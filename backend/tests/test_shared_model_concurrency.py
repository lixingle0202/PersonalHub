import asyncio
from contextlib import AsyncExitStack
import json
import sqlite3
from threading import Barrier, Event, Lock

import httpx
from fastapi import HTTPException

from app.public import SHARED_MODEL_CONCURRENCY, create_public_app
from app.services import ollama

HOST = 'https://concurrent.example.test'
REQUIREMENTS = {'topic': 'Python', 'objective': '读写CSV文件', 'start_date': '2026-10-23', 'days': 1, 'daily_minutes': 45}
PLAN = {'name': 'CSV文件练习', 'goal': '读写CSV文件', 'sections': ['文件读写'], 'tasks': [
    {'day_number': 1, 'section_index': 0, 'title': '读写两行CSV数据', 'minutes': 45,
     'notes': '学习CSV文件格式15分钟；练习读写文件25分钟；产出：CSV处理脚本；验收5分钟：文件两行数据读写结果与预期一致。'},
]}


async def signed_in(stack, app, name):
    client = await stack.enter_async_context(httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=HOST))
    response = await client.post('/api/v1/public/register', json={'username': name, 'password': 'test-long-password'})
    assert response.status_code == 200
    bootstrap = await client.get('/api/v1/bootstrap')
    client.headers['x-local-token'] = bootstrap.json()['local_token']
    return client


def dispose(app):
    for user_app in app.user_apps.values():
        user_app.state.database.dispose()


def test_three_accounts_generate_at_once_and_their_drafts_remain_private(tmp_path, monkeypatch):
    app = create_public_app(tmp_path / 'concurrent')
    barrier = Barrier(SHARED_MODEL_CONCURRENCY, timeout=10)
    lock = Lock()
    active = peak = 0

    def inference(*_args, **_kwargs):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        try:
            barrier.wait()
            return {'message': {'content': json.dumps(PLAN)}}
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr(ollama, 'ollama_request', inference)

    async def run():
        async with AsyncExitStack() as stack:
            clients = [await signed_in(stack, app, name) for name in ['alice', 'bobby', 'carol']]
            responses = await asyncio.gather(*[client.post('/api/v1/ai/learning/generate', json=REQUIREMENTS) for client in clients])
            assert [response.status_code for response in responses] == [200, 200, 200]
            drafts = [response.json()['id'] for response in responses]
            assert len(set(drafts)) == 3
            for index, client in enumerate(clients):
                assert (await client.get(f'/api/v1/ai/learning/drafts/{drafts[index]}')).status_code == 200
                assert (await client.get(f'/api/v1/ai/learning/drafts/{drafts[(index + 1) % 3]}')).status_code == 404
    try:
        asyncio.run(run())
        assert peak == 3
        assert not app.generating_users
        with sqlite3.connect(app.store.path) as connection:
            assert connection.execute('SELECT count FROM model_usage').fetchall() == [(1,), (1,), (1,)]
    finally:
        dispose(app)


def test_duplicate_user_is_rejected_and_failure_returns_capacity_and_quota(tmp_path, monkeypatch):
    app = create_public_app(tmp_path / 'recovery')
    entered, release = Event(), Event()
    attempts = 0

    def inference(*_args, **_kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            entered.set()
            assert release.wait(10)
            raise HTTPException(503, '模型暂不可用')
        return {'message': {'content': json.dumps(PLAN)}}

    monkeypatch.setattr(ollama, 'ollama_request', inference)

    async def run():
        async with AsyncExitStack() as stack:
            client = await signed_in(stack, app, 'alice')
            first = asyncio.create_task(client.post('/api/v1/ai/learning/generate', json=REQUIREMENTS))
            try:
                assert await asyncio.to_thread(entered.wait, 10)
                duplicate = await client.post('/api/v1/ai/learning/generate', json=REQUIREMENTS)
                assert duplicate.status_code == 429
                assert duplicate.json()['code'] == 'user_model_busy'
            finally:
                release.set()
            assert (await first).status_code == 503
            assert not app.generating_users
            assert (await client.post('/api/v1/ai/learning/generate', json=REQUIREMENTS)).status_code == 200
    try:
        asyncio.run(run())
        assert attempts == 2 and not app.generating_users
        assert not app.model_gate.locked()
        with sqlite3.connect(app.store.path) as connection:
            assert connection.execute('SELECT count FROM model_usage').fetchone() == (1,)
    finally:
        dispose(app)
