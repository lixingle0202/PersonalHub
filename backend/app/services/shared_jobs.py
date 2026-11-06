"""Account-private, bounded background generation behind short polling requests."""
import asyncio
from dataclasses import dataclass, field
from contextlib import asynccontextmanager
import logging
from threading import Event
import time
from typing import Any
import uuid

import httpx
from fastapi import HTTPException

from .generation_budget import GenerationBudget, current_budget


logger = logging.getLogger(__name__)
TERMINAL = {'completed', 'failed', 'cancelled'}
MAX_JOB_SECONDS = 10 * 60


@dataclass
class GenerationJob:
    id: str
    user_id: str
    path: str
    requirements: dict
    request_key: str
    created: float = field(default_factory=time.monotonic)
    state: str = 'queued'
    result: dict | None = None
    error: str = ''
    error_status: int = 500
    cancelled: Event = field(default_factory=Event)
    task: asyncio.Task | None = None


class SharedGenerationJobs:
    def __init__(self, gate, generating_users: set[str], store):
        self.gate = gate
        self.generating_users = generating_users
        self.store = store
        self.jobs: dict[str, GenerationJob] = {}

    def _prune(self):
        terminal = [job for job in self.jobs.values() if job.state in TERMINAL]
        for job in terminal:
            if time.monotonic() - job.created > 3600 or len(self.jobs) > 256:
                self.jobs.pop(job.id, None)

    def active(self, user_id: str) -> GenerationJob | None:
        return next((job for job in self.jobs.values() if job.user_id == user_id and job.state not in TERMINAL), None)

    def get(self, user_id: str, job_id: str) -> GenerationJob:
        self._prune()
        job = self.jobs.get(job_id)
        if job is None or job.user_id != user_id:
            raise HTTPException(404, '生成任务不存在或已过期，请重新生成')
        return job

    def snapshot(self, job: GenerationJob) -> dict[str, Any]:
        queued = [item.id for item in self.jobs.values() if item.state == 'queued']
        return {
            'job_id': job.id, 'state': job.state,
            'queue_position': queued.index(job.id) + 1 if job.id in queued else 0,
            'elapsed_seconds': max(0, int(time.monotonic() - job.created)),
            'result': job.result if job.state == 'completed' else None,
            'detail': job.error, 'error_status': job.error_status,
        }

    def start(self, user_id: str, app, path: str, requirements: dict, request_key: str) -> GenerationJob:
        self._prune()
        for job in self.jobs.values():
            if job.user_id == user_id and job.request_key == request_key:
                if job.path != path or job.requirements != requirements:
                    raise HTTPException(409, '这个生成请求已用于其他内容，请重新操作')
                return job
        active = self.active(user_id)
        if active:
            if active.path == path and active.requirements == requirements and active.state != 'cancelling':
                return active
            raise HTTPException(409, '你已有一个生成任务正在处理，请先等待完成或取消它')
        if user_id in self.generating_users:
            raise HTTPException(429, '上一个生成请求仍在处理，请稍后重试')
        if sum(job.state == 'queued' for job in self.jobs.values()) >= 12:
            raise HTTPException(429, '当前排队人数较多，请稍后再试')
        job = GenerationJob(str(uuid.uuid4()), user_id, path, requirements, request_key)
        self.jobs[job.id] = job
        job.task = asyncio.create_task(self._run(job, app))
        return job

    @asynccontextmanager
    async def _slot(self, job):
        await asyncio.wait_for(self.gate.acquire(), timeout=max(0.001, MAX_JOB_SECONDS - (time.monotonic() - job.created)))
        try:
            yield
        finally:
            self.gate.release()

    async def _run(self, job: GenerationJob, app):
        reserved = owned_slot = False
        try:
            async with self._slot(job):
                if job.cancelled.is_set():
                    job.state = 'cancelled'
                    return
                if time.monotonic() - job.created >= MAX_JOB_SECONDS:
                    raise HTTPException(504, '排队时间过长，本次未扣除生成次数，请稍后重试')
                if job.user_id in self.generating_users:
                    raise HTTPException(409, '上一个生成请求仍在处理，请稍后重试')
                self.generating_users.add(job.user_id)
                owned_slot = True
                reserved = self.store.reserve_generation(job.user_id)
                if not reserved:
                    raise HTTPException(429, '今天的生成次数已用完，请明天再试')
                job.state = 'running'
                token = current_budget.set(GenerationBudget(job.created + MAX_JOB_SECONDS, job.cancelled))
                try:
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                                 base_url='http://generation.internal', timeout=None) as client:
                        response = await client.post(job.path, json=job.requirements,
                                                     headers={'x-local-token': app.state.local_token})
                    if job.cancelled.is_set():
                        job.state = 'cancelled'
                    elif response.is_success:
                        result = response.json()
                        required = {'id', 'plan'} if '/learning/' in job.path else {'plan'}
                        if not isinstance(result, dict) or not required <= result.keys() or not isinstance(result['plan'], dict):
                            raise ValueError('Invalid generation response')
                        job.result = result
                        job.state = 'completed'
                    else:
                        try:
                            detail = response.json().get('detail')
                        except (ValueError, AttributeError):
                            detail = None
                        raise HTTPException(response.status_code, detail if isinstance(detail, str) else '生成未完成，请稍后重试')
                finally:
                    current_budget.reset(token)
        except asyncio.CancelledError:
            job.state = 'cancelled'
        except TimeoutError:
            job.state = 'failed'
            job.error = '排队时间过长，本次未扣除生成次数，请稍后重试'
            job.error_status = 504
        except HTTPException as exc:
            job.state = 'cancelled' if job.cancelled.is_set() else 'failed'
            job.error = str(exc.detail)
            job.error_status = exc.status_code
        except Exception:
            logger.exception('Shared generation job failed')
            job.state = 'failed'
            job.error = '共享模型暂时不可用，本次未扣除生成次数，请稍后重试'
        finally:
            if reserved and job.state != 'completed':
                self.store.refund_generation(job.user_id)
            if owned_slot:
                self.generating_users.discard(job.user_id)

    def cancel(self, user_id: str, job_id: str) -> GenerationJob:
        job = self.get(user_id, job_id)
        if job.state not in TERMINAL:
            job.cancelled.set()
            if job.state == 'queued':
                job.state = 'cancelled'
                if job.task:
                    job.task.cancel()
            else:
                # The streaming model request observes this event and closes its
                # connection; hold capacity until that worker actually finishes.
                job.state = 'cancelling'
        return job

    async def close(self):
        tasks = []
        for job in self.jobs.values():
            if job.task and not job.task.done():
                job.cancelled.set()
                job.task.cancel()
                tasks.append(job.task)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
