"""Login-enabled, offline desktop application with its own bundled AI runtime."""
from __future__ import annotations

from dataclasses import replace
import hashlib
import logging
import os
import secrets
from pathlib import Path
import sys
import threading
import time
import webbrowser
from typing import Literal

import httpx
import uvicorn
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .config import Settings
from .launcher import InstanceLock, RuntimeState, configure_logging, find_available_port, open_browser_when_ready, read_runtime_state, remove_own_runtime_state, write_runtime_state
from .public import PublicHub
from .models import Setting
from .api.ai import read_config
from .services.ollama import LocalEndpoint, OllamaSettings
from .services.desktop_ollama import DesktopOllama, MODEL

LOGGER = logging.getLogger(__name__)


class DesktopModelChoice(OllamaSettings):
    source: Literal['builtin', 'local'] = 'builtin'


def desktop_settings() -> Settings:
    base = Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData' / 'Local'))
    root = Path(os.environ.get('PERSONAL_HUB_DESKTOP_DATA_DIR', str(base / 'PersonalHubDesktop'))).resolve()
    return Settings(data_root=root, port=int(os.environ.get('PERSONAL_HUB_DESKTOP_PORT', '8770')))


class DesktopHub(PublicHub):
    def __init__(self, data_root: Path, model_url: str):
        super().__init__(data_root, model=MODEL, secure_cookie=False, model_url=model_url,
                         model_concurrency=1, daily_generations=None, desktop_mode=True)
        self.data_id = hashlib.sha256(str(self.data_root).encode('utf-8')).hexdigest()
        self.http = TrustedHostMiddleware(self.http, allowed_hosts=['127.0.0.1', 'localhost', 'testserver'])

    def _configure_user_model(self, session):
        source = session.get(Setting, 'desktop_ai_source')
        if source and source.value_json == '"local"' and session.get(Setting, 'ai_ollama'):
            return
        super()._configure_user_model(session)

    def _model_choice(self, app):
        with app.state.database.session() as session:
            config = read_config(session).model_dump()
            source = session.get(Setting, 'desktop_ai_source')
            return {**config, 'source': 'local' if source and source.value_json == '"local"' else 'builtin'}

    async def _model_names(self, base_url):
        try:
            async with httpx.AsyncClient(trust_env=False, timeout=5, follow_redirects=False) as client:
                response = await client.get(base_url + '/api/tags')
                response.raise_for_status()
                entries = response.json()['models']
                if not isinstance(entries, list):
                    raise ValueError('Invalid model list')
                return sorted({item['name'] for item in entries if isinstance(item, dict) and isinstance(item.get('name'), str)})
        except (httpx.HTTPError, KeyError, ValueError, TypeError) as exc:
            raise HTTPException(503, '无法连接此 Ollama，请先启动服务并检查本机地址。') from exc

    async def _handle_http(self, scope, receive, send):
        if scope['path'] == '/health':
            return await JSONResponse({'status': 'ok', 'mode': 'desktop', 'host': '127.0.0.1',
                                       'data_id': self.data_id})(scope, receive, send)
        if scope['path'].startswith('/api/v1/desktop/ai/'):
            request = Request(scope, receive)
            if self._forbidden_origin(request):
                return await JSONResponse({'detail': '跨站请求被拒绝'}, status_code=403)(scope, receive, send)
            user = self.store.user_for(request.cookies.get('personalhub_public_session'))
            if not user:
                return await JSONResponse({'detail': '请先登录'}, status_code=401)(scope, receive, send)
            app = self._user_app(user)
            try:
                if request.method not in {'GET', 'HEAD'} and not secrets.compare_digest(request.headers.get('x-local-token', ''), app.state.local_token):
                    raise HTTPException(403, '操作令牌不正确，请刷新后重试')
                path = scope['path'].rsplit('/', 1)[-1]
                choice = self._model_choice(app)
                if path == 'settings' and request.method == 'GET':
                    result = choice
                elif path == 'models' and request.method == 'POST':
                    endpoint = LocalEndpoint.model_validate_json(await request.body())
                    result = {'models': await self._model_names(endpoint.base_url)}
                elif path == 'settings' and request.method == 'PUT':
                    if self.generation_jobs.active(user.id) or user.id in self.generating_users:
                        raise HTTPException(409, '请等待当前生成完成或取消后，再切换模型。')
                    selected = DesktopModelChoice.model_validate_json(await request.body())
                    config = OllamaSettings(base_url=self.model_url, model=self.model) if selected.source == 'builtin' else OllamaSettings(base_url=selected.base_url, model=selected.model)
                    if not config.model or config.model not in await self._model_names(config.base_url):
                        raise HTTPException(422, '所选模型尚未安装，请刷新列表并选择已下载的模型。')
                    if self.generation_jobs.active(user.id) or user.id in self.generating_users:
                        raise HTTPException(409, '请等待当前生成完成或取消后，再切换模型。')
                    with app.state.database.session() as session:
                        for key, value in [('ai_ollama', config.model_dump_json()), ('desktop_ai_source', '"' + selected.source + '"')]:
                            saved = session.get(Setting, key)
                            if saved:
                                saved.value_json = value
                            else:
                                session.add(Setting(key=key, value_json=value))
                    result = {**config.model_dump(), 'source': selected.source}
                elif path == 'status' and request.method == 'GET':
                    try:
                        ready = choice['model'] in await self._model_names(choice['base_url'])
                        result = {**choice, 'ready': ready, 'detail': None if ready else '所选模型尚未安装，请重新选择。'}
                    except HTTPException as exc:
                        result = {**choice, 'ready': False, 'detail': exc.detail}
                else:
                    raise HTTPException(405, '不支持的操作')
                response = JSONResponse(result, headers={'Cache-Control': 'no-store'})
            except ValidationError:
                response = JSONResponse({'detail': '请填写有效的本机 Ollama 地址和模型。'}, status_code=422)
            except HTTPException as exc:
                response = JSONResponse({'detail': exc.detail}, status_code=exc.status_code)
            return await response(scope, receive, send)
        return await super()._handle_http(scope, receive, send)


def existing_desktop_url(settings: Settings) -> str | None:
    expected = hashlib.sha256(str(settings.data_root.resolve()).encode('utf-8')).hexdigest()
    with httpx.Client(trust_env=False, timeout=.5) as client:
        for _ in range(100):
            state = read_runtime_state(settings)
            if state:
                try:
                    health = client.get(state.url + '/health').json()
                    if health.get('mode') == 'desktop' and health.get('data_id') == expected:
                        return state.url
                except (httpx.HTTPError, ValueError):
                    pass
            time.sleep(.1)
    return None


def main() -> int:
    requested = desktop_settings()
    requested.ensure_directories()
    lock = InstanceLock(requested.data_root / 'instance.lock')
    if not lock.acquire():
        existing = existing_desktop_url(requested)
        if existing:
            if os.environ.get('PERSONAL_HUB_NO_BROWSER') != '1':
                webbrowser.open(existing, new=2)
            return 0
        print('PersonalHub is already starting. Please try again in a moment.')
        return 1
    settings = replace(requested, port=find_available_port(requested.port))
    configure_logging(settings)
    model = DesktopOllama(settings.data_root)
    try:
        print('PersonalHub: starting the complete local app and built-in AI. Please wait...', flush=True)
        model_url = model.start()
        app = DesktopHub(settings.data_root, model_url)
        url = f'http://127.0.0.1:{settings.port}'
        write_runtime_state(settings, RuntimeState(url, os.getpid(), str(settings.data_root / 'accounts.sqlite3')))
        if os.environ.get('PERSONAL_HUB_NO_BROWSER') != '1':
            threading.Thread(target=open_browser_when_ready, args=(url,), daemon=True).start()
        LOGGER.info('Full desktop app: %s; local accounts: %s', url, settings.data_root)
        uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=settings.port,
                                     log_level='info', access_log=False)).run()
        return 0
    except Exception:
        LOGGER.exception('PersonalHub desktop could not start')
        if os.name == 'nt' and os.environ.get('PERSONAL_HUB_NO_BROWSER') != '1':
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, 'PersonalHub 启动失败。请完整解压软件包，并查看数据目录 logs 中的日志。', 'PersonalHub', 0x10)
        return 1
    finally:
        model.close()
        remove_own_runtime_state(settings)
        lock.release()


if __name__ == '__main__':
    sys.exit(main())
