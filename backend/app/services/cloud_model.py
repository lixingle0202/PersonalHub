"""Server-owned Bailian configuration; credentials never enter user databases."""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
import json
import os
import re
from urllib.parse import urlsplit

from fastapi import HTTPException
import httpx


DEFAULT_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1'


@dataclass(frozen=True)
class BailianSettings:
    model: str = 'qwen-plus'
    api_key: str = field(default='', repr=False)
    base_url: str = DEFAULT_ENDPOINT
    enabled: bool = False
    free_only_confirmed: bool = False

    def __post_init__(self):
        parts = urlsplit(self.base_url)
        hostname = parts.hostname or ''
        allowed = hostname == 'dashscope.aliyuncs.com' or re.fullmatch(
            r'[a-zA-Z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com', hostname)
        if (parts.scheme != 'https' or not allowed or parts.port not in (None, 443)
                or parts.path.rstrip('/') != '/compatible-mode/v1'
                or parts.username or parts.password or parts.query or parts.fragment):
            raise ValueError('云端模型须使用百炼北京地域的 HTTPS 兼容接口地址')
        if not self.model.strip() or len(self.model) > 200:
            raise ValueError('请配置控制台中具有免费额度的模型 Code')
        if self.enabled and (not self.api_key.strip() or not self.free_only_confirmed):
            raise ValueError('启用云端 AI 前须配置 API Key，并确认控制台已开启免费额度用完即停')

    @classmethod
    def from_environment(cls) -> BailianSettings:
        return cls(
            model=os.environ.get('PERSONAL_HUB_PUBLIC_MODEL', 'qwen-plus').strip(),
            api_key=os.environ.get('DASHSCOPE_API_KEY', '').strip(),
            base_url=os.environ.get('DASHSCOPE_BASE_URL', DEFAULT_ENDPOINT).rstrip('/'),
            enabled=os.environ.get('PERSONAL_HUB_CLOUD_AI_ENABLED', 'false').lower() == 'true',
            free_only_confirmed=os.environ.get('PERSONAL_HUB_FREE_ONLY_CONFIRMED', 'false').lower() == 'true',
        )

    def public_view(self) -> dict:
        return {'base_url': self.base_url, 'model': self.model, 'provider': 'bailian', 'enabled': self.enabled}


def bailian_request(settings: BailianSettings, path: str, payload: dict | None) -> dict:
    if not settings.enabled:
        raise HTTPException(503, '共享 AI 尚未开通，计划和记录等普通功能可继续使用')
    if path != '/api/chat' or not isinstance(payload, dict) or not isinstance(payload.get('format'), dict):
        raise HTTPException(422, '云端模型只接受本站的结构化计划生成请求')
    messages = deepcopy(payload['messages'])
    schema = '请仅返回符合以下 JSON Schema 的 JSON 对象：\n' + json.dumps(payload['format'], ensure_ascii=False)
    messages[0] = {**messages[0], 'content': messages[0]['content'] + '\n' + schema}
    body = {
        'model': settings.model, 'messages': messages, 'stream': False,
        'response_format': {'type': 'json_object'}, 'enable_thinking': False,
        'temperature': 0.2, 'max_tokens': 8192,
    }
    try:
        with httpx.Client(timeout=httpx.Timeout(180, connect=10), trust_env=False, follow_redirects=False) as client:
            response = client.post(settings.base_url.rstrip('/') + '/chat/completions', json=body,
                                   headers={'Authorization': 'Bearer ' + settings.api_key})
        if response.status_code in (401, 403):
            try:
                error = response.json().get('error', {})
                quota_exhausted = 'freetier' in str(error.get('code', '')).lower()
            except (ValueError, AttributeError):
                quota_exhausted = False
            detail = ('当前模型免费额度已到期或用完，AI 生成已暂停，普通功能可继续使用'
                      if quota_exhausted else '云端模型认证或权限异常，请联系网站管理员检查配置')
            raise HTTPException(503, detail)
        if response.status_code == 429:
            raise HTTPException(503, '云端模型当前请求较多，请稍后重试')
        if response.status_code != 200:
            raise HTTPException(502, '云端模型服务暂时不可用，请稍后重试')
        result = response.json()
        choice = result['choices'][0]
        content = choice['message']['content']
        if not isinstance(content, str) or not content.strip() or choice.get('finish_reason') != 'stop':
            raise ValueError('Incomplete model output')
        return {'message': {'content': content}, 'done': True, 'done_reason': 'stop'}
    except httpx.TimeoutException as exc:
        raise HTTPException(504, '云端模型响应超时，请缩短计划天数后重试') from exc
    except httpx.RequestError as exc:
        raise HTTPException(503, '暂时无法连接云端模型，请稍后重试') from exc
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise HTTPException(502, '云端模型未返回完整的计划，尚未导入，请重试') from exc
