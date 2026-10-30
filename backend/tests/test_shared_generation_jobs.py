import asyncio
from contextlib import AsyncExitStack
import json
import sqlite3
from threading import Event, Lock
import time

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.public import SHARED_MODEL_CONCURRENCY, create_public_app
from app.services import ollama, shared_jobs
from app.services.generation_budget import GenerationBudget, current_budget, remaining_seconds


REQUIREMENTS = {'topic': 'Python', 'objective': '读写CSV文件', 'start_date': '2026-12-01', 'days': 1, 'daily_minutes': 45}
PLAN = {'name': 'CSV读写', 'goal': '读写CSV文件', 'sections': ['文件处理'], 'tasks': [
    {'day_number': 1, 'section_index': 0, 'title': '读写两行CSV数据', 'minutes': 45,
     'notes': '学习CSV文件格式15分钟；练习读取和写入文件25分钟；产出：CSV读写脚本；验收5分钟：读回文件两行数据并与原数据核对。'},
]}


async def login(stack, app, name):
    browser = await stack.enter_async_context(httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://jobs.example.test'))
    assert (await browser.post('/api/v1/public/register', json={'username': name, 'password': 'test-long-password'})).status_code == 200
    browser.headers['x-local-token'] = (await browser.get('/api/v1/bootstrap')).json()['local_token']
    return browser


async def submit(browser, key='a-test-generation-key', requirements=None):
    response = await asyncio.wait_for(browser.post('/api/v1/ai/learning/generate', json=requirements or REQUIREMENTS,
        headers={'Prefer': 'respond-async', 'X-Generation-Key': key}), timeout=3)
    assert response.status_code == 202, response.text
    return response.json()['job_id']


def dispose(app):
    for user_app in app.user_apps.values():
        user_app.state.database.dispose()


def test_jobs_return_immediately_run_three_at_once_queue_fourth_and_keep_results_private(tmp_path, monkeypatch):
    app = create_public_app(tmp_path / 'public')
    release = Event()
    all_entered = Event()
    lock = Lock()
    active = peak = 0

    def inference(*args):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
            if active == SHARED_MODEL_CONCURRENCY:
                all_entered.set()
        try:
            assert release.wait(15)
            return {'message': {'content': json.dumps(PLAN)}}
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr(ollama, 'ollama_request', inference)

    async def run():
        async with AsyncExitStack() as stack:
            clients = [await login(stack, app, name) for name in ['alice', 'bobby', 'carol', 'david']]
            ids = [await submit(browser) for browser in clients]
            try:
                assert await asyncio.to_thread(all_entered.wait, 10)
                fourth = (await clients[3].get('/api/v1/ai/shared/jobs/' + ids[3])).json()
                assert fourth['state'] == 'queued' and fourth['queue_position'] == 1
                assert await submit(clients[0]) == ids[0]
                assert (await clients[1].get('/api/v1/ai/shared/jobs/' + ids[0])).status_code == 404
                assert (await clients[1].delete('/api/v1/ai/shared/jobs/' + ids[0])).status_code == 404
                with sqlite3.connect(app.store.path) as db:
                    assert sum(row[0] for row in db.execute('SELECT count FROM model_usage')) == 3
            finally:
                release.set()
            await asyncio.wait_for(asyncio.gather(*(job.task for job in app.generation_jobs.jobs.values())), 15)
            drafts = []
            for browser, job_id in zip(clients, ids):
                result = (await browser.get('/api/v1/ai/shared/jobs/' + job_id)).json()
                assert result['state'] == 'completed', result
                drafts.append(result['result']['id'])
            assert len(set(drafts)) == 4
            assert (await clients[1].get('/api/v1/ai/learning/drafts/' + drafts[0])).status_code == 404
            assert not app.generating_users and not app.model_gate.locked()
    try:
        asyncio.run(run())
        assert peak == SHARED_MODEL_CONCURRENCY
    finally:
        release.set()
        dispose(app)


def test_failed_job_returns_quota_and_capacity_and_same_key_cannot_duplicate_generation(tmp_path, monkeypatch):
    app = create_public_app(tmp_path / 'public')
    calls = []

    def inference(*args):
        calls.append(True)
        if len(calls) == 1:
            raise HTTPException(503, '共享模型暂时未连接')
        return {'message': {'content': json.dumps(PLAN)}}

    monkeypatch.setattr(ollama, 'ollama_request', inference)

    async def run():
        async with AsyncExitStack() as stack:
            browser = await login(stack, app, 'alice')
            job_id = await submit(browser)
            await app.generation_jobs.jobs[job_id].task
            failed = (await browser.get('/api/v1/ai/shared/jobs/' + job_id)).json()
            assert failed['state'] == 'failed' and failed['error_status'] == 503
            assert '未连接' in failed['detail']
            assert await submit(browser) == job_id
            assert len(calls) == 1
            retry = await submit(browser, 'another-test-generation-key')
            await app.generation_jobs.jobs[retry].task
            assert (await browser.get('/api/v1/ai/shared/jobs/' + retry)).json()['state'] == 'completed'
            assert not app.generating_users
    try:
        asyncio.run(run())
        with sqlite3.connect(app.store.path) as db:
            assert db.execute('SELECT count FROM model_usage').fetchone() == (1,)
    finally:
        dispose(app)


def test_cancelled_queued_job_never_calls_model_or_consumes_quota_and_requires_own_token(tmp_path, monkeypatch):
    app = create_public_app(tmp_path / 'public')
    calls = []
    monkeypatch.setattr(ollama, 'ollama_request', lambda *args: calls.append(True))

    async def run():
        async with AsyncExitStack() as stack:
            browser = await login(stack, app, 'alice')
            for _ in range(SHARED_MODEL_CONCURRENCY):
                await app.model_gate.acquire()
            try:
                job_id = await submit(browser)
                path = '/api/v1/ai/shared/jobs/' + job_id
                assert (await browser.delete(path, headers={'x-local-token': 'wrong'})).status_code == 403
                assert (await browser.delete(path)).json()['state'] == 'cancelled'
                await asyncio.gather(app.generation_jobs.jobs[job_id].task, return_exceptions=True)
                assert not calls
            finally:
                for _ in range(SHARED_MODEL_CONCURRENCY):
                    app.model_gate.release()
    try:
        asyncio.run(run())
        with sqlite3.connect(app.store.path) as db:
            assert db.execute('SELECT count(*) FROM model_usage').fetchone() == (0,)
    finally:
        dispose(app)


def test_cancelled_running_job_observes_cancellation_releases_slot_and_refunds_quota(tmp_path, monkeypatch):
    app = create_public_app(tmp_path / 'public')
    entered = Event()

    def inference(*args):
        budget = current_budget.get()
        assert budget is not None
        entered.set()
        assert budget.cancelled.wait(10)
        remaining_seconds()

    monkeypatch.setattr(ollama, 'ollama_request', inference)

    async def run():
        async with AsyncExitStack() as stack:
            browser = await login(stack, app, 'alice')
            job_id = await submit(browser)
            assert await asyncio.to_thread(entered.wait, 10)
            await browser.delete('/api/v1/ai/shared/jobs/' + job_id)
            await asyncio.wait_for(app.generation_jobs.jobs[job_id].task, 10)
            assert (await browser.get('/api/v1/ai/shared/jobs/' + job_id)).json()['state'] == 'cancelled'
            assert not app.generating_users and not app.model_gate.locked()
    try:
        asyncio.run(run())
        with sqlite3.connect(app.store.path) as db:
            assert db.execute('SELECT count FROM model_usage').fetchone() == (0,)
    finally:
        dispose(app)


def test_queue_deadline_ends_wait_without_calling_model_and_invalid_requests_never_queue(tmp_path, monkeypatch):
    app = create_public_app(tmp_path / 'public')
    monkeypatch.setattr(shared_jobs, 'MAX_JOB_SECONDS', .05)

    async def run():
        async with AsyncExitStack() as stack:
            browser = await login(stack, app, 'alice')
            invalid = await browser.post('/api/v1/ai/learning/generate', headers={'Prefer': 'respond-async'}, json={'topic': '缺少要求'})
            assert invalid.status_code == 422 and not app.generation_jobs.jobs
            for _ in range(SHARED_MODEL_CONCURRENCY):
                await app.model_gate.acquire()
            try:
                job_id = await submit(browser)
                await asyncio.wait_for(app.generation_jobs.jobs[job_id].task, 2)
                result = (await browser.get('/api/v1/ai/shared/jobs/' + job_id)).json()
                assert result['state'] == 'failed' and result['error_status'] == 504
                assert '排队时间过长' in result['detail']
            finally:
                for _ in range(SHARED_MODEL_CONCURRENCY):
                    app.model_gate.release()
    try:
        asyncio.run(run())
    finally:
        dispose(app)


def test_restarted_shared_service_replaces_an_old_account_model_with_current_server_policy(tmp_path):
    from app.models import Setting
    root = tmp_path / 'public'
    first = create_public_app(root)
    with TestClient(first, base_url='https://jobs.example.test') as browser:
        assert browser.post('/api/v1/public/register', json={'username': 'alice', 'password': 'test-long-password'}).status_code == 200
        browser.get('/api/v1/bootstrap')
        user_app = next(iter(first.user_apps.values()))
        with user_app.state.database.session() as session:
            session.get(Setting, 'ai_ollama').value_json = json.dumps({'base_url': 'http://127.0.0.1:9999', 'model': 'removed-model'})
        cookies = dict(browser.cookies)
    restarted = create_public_app(root, model='qwen2.5:1.5b')
    with TestClient(restarted, base_url='https://jobs.example.test', cookies=cookies) as browser:
        assert browser.get('/api/v1/ai/ollama/settings').json() == {'base_url': 'http://127.0.0.1:11434', 'model': 'qwen2.5:1.5b'}


@pytest.mark.parametrize('cancelled', [False, True])
def test_streaming_model_requests_join_tokens_and_close_connection_on_cancel(monkeypatch, cancelled):
    event = Event()
    closed = []
    original = httpx.Client

    class Tokens(httpx.SyncByteStream):
        def __iter__(self):
            yield (json.dumps({'message': {'content': '{"name":'}}) + '\n').encode()
            if cancelled:
                event.set()
            yield (json.dumps({'message': {'content': '"测试"}'}, 'done': True, 'done_reason': 'stop'}) + '\n').encode()

        def close(self):
            closed.append(True)

    def transport(request):
        assert json.loads(request.content)['stream'] is True
        return httpx.Response(200, stream=Tokens())

    monkeypatch.setattr(httpx, 'Client', lambda **kwargs: original(transport=httpx.MockTransport(transport), **kwargs))
    token = current_budget.set(GenerationBudget(time.monotonic() + 60, event))
    try:
        if cancelled:
            with pytest.raises(HTTPException) as error:
                ollama.ollama_request(ollama.OllamaSettings(model='qwen2.5:1.5b'), '/api/chat', {'messages': []})
            assert error.value.status_code == 499
        else:
            result = ollama.ollama_request(ollama.OllamaSettings(model='qwen2.5:1.5b'), '/api/chat', {'messages': []})
            assert json.loads(result['message']['content']) == {'name': '测试'} and result['done'] is True
    finally:
        current_budget.reset(token)
    assert closed
