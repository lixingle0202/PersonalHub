from __future__ import annotations

import json
from collections import defaultdict
from datetime import date, timedelta
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator


class LocalEndpoint(BaseModel):
    base_url: str = "http://127.0.0.1:11434"

    @field_validator("base_url")
    @classmethod
    def local_url(cls, value: str) -> str:
        value = value.strip().rstrip('/')
        parts = urlsplit(value)
        if (parts.scheme not in {"http", "https"} or parts.hostname not in {"127.0.0.1", "localhost", "::1"}
                or parts.username or parts.password or parts.path or parts.query or parts.fragment):
            raise ValueError("请填写本机 Ollama 地址，例如 http://127.0.0.1:11434")
        try:
            _ = parts.port
        except ValueError as exc:
            raise ValueError("Ollama 端口不正确") from exc
        return value


class OllamaSettings(LocalEndpoint):
    model: str = Field(default="", max_length=200)

    @field_validator("model")
    @classmethod
    def clean_model(cls, value: str) -> str:
        return value.strip()


class LearningGenerateRequest(BaseModel):
    topic: str = Field(min_length=1, max_length=200)
    objective: str = Field(min_length=1, max_length=2000)
    current_level: str = Field(default="零基础", max_length=1000)
    preferences: str = Field(default="", max_length=2000)
    start_date: date
    days: int = Field(default=7, ge=1, le=30)
    daily_minutes: int = Field(default=45, ge=5, le=480)

    @field_validator("topic", "objective")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("学习主题和目标不能为空")
        return value.strip()


class ModelTask(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    day_number: int = Field(ge=1, le=30)
    section_index: int = Field(ge=0)
    title: str = Field(min_length=1, max_length=300)
    minutes: int = Field(ge=1, le=480)
    notes: str = Field(max_length=2000)


class ModelLearningPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=200)
    goal: str = Field(min_length=1, max_length=2000)
    sections: list[str] = Field(min_length=1, max_length=30)
    tasks: list[ModelTask] = Field(min_length=1, max_length=90)


class PreviewTask(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    plan_date: date
    section_index: int = Field(ge=0)
    title: str = Field(min_length=1, max_length=300)
    minutes: int = Field(ge=1, le=480)
    notes: str = Field(default="", max_length=2000)


class LearningPreview(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=200)
    goal: str = Field(min_length=1, max_length=2000)
    start_date: date
    target_date: date
    daily_minutes: int = Field(ge=5, le=480)
    sections: list[str] = Field(min_length=1, max_length=30)
    tasks: list[PreviewTask] = Field(min_length=1, max_length=90)

    @model_validator(mode="after")
    def valid_schedule(self):
        if not 0 <= (self.target_date - self.start_date).days < 30:
            raise ValueError("计划日期范围必须为 1 至 30 天")
        if any(not name.strip() or len(name) > 200 for name in self.sections):
            raise ValueError("章节名称不能为空或超过 200 字")
        self.sections = [name.strip() for name in self.sections]
        daily_totals = defaultdict(int)
        seen = set()
        for task in self.tasks:
            if not self.start_date <= task.plan_date <= self.target_date:
                raise ValueError("学习任务日期超出计划范围")
            if task.section_index >= len(self.sections):
                raise ValueError("学习任务引用了不存在的章节")
            key = (task.plan_date, task.title)
            if key in seen:
                raise ValueError("同一天的学习任务不能重复")
            seen.add(key)
            daily_totals[task.plan_date] += task.minutes
        if any(total > self.daily_minutes for total in daily_totals.values()):
            raise ValueError("某天的任务总时长超过每天可用时间，请调整后重试")
        return self


def ollama_request(settings: LocalEndpoint, path: str, payload: dict | None = None) -> dict:
    try:
        with httpx.Client(timeout=httpx.Timeout(300 if payload else 10, connect=3),
                          trust_env=False, follow_redirects=False) as client:
            response = client.get(f"{settings.base_url}{path}") if payload is None else client.post(f"{settings.base_url}{path}", json=payload)
            if response.status_code == 404 and path == "/api/chat":
                raise HTTPException(422, "模型未安装或模型名称不正确，请在本地大模型设置中刷新模型列表")
            if response.status_code != 200:
                raise HTTPException(502, f"Ollama 返回错误（{response.status_code}），请检查本机模型服务")
            data = response.json()
            if not isinstance(data, dict) or data.get("error"):
                raise ValueError("Invalid Ollama response")
            return data
    except httpx.TimeoutException as exc:
        raise HTTPException(504, "本地模型响应超时，请缩短计划天数或换用更小的模型后重试") from exc
    except httpx.RequestError as exc:
        raise HTTPException(503, "无法连接本机 Ollama，请先安装并启动 Ollama，再检查服务地址") from exc
    except (ValueError, TypeError) as exc:
        raise HTTPException(502, "Ollama 返回的数据格式不正确，请检查本地模型服务") from exc


def list_models(settings: LocalEndpoint) -> list[str]:
    data = ollama_request(settings, "/api/tags")
    models = data.get("models")
    if not isinstance(models, list):
        raise HTTPException(502, "Ollama 模型列表格式不正确")
    return sorted({model['name'] for model in models if isinstance(model, dict) and isinstance(model.get('name'), str)})


def generate_learning_plan(settings: OllamaSettings, request: LearningGenerateRequest) -> LearningPreview:
    if not settings.model:
        raise HTTPException(422, "请先在数据与设置 → 本地大模型中选择并保存一个 Ollama 模型")
    schema = ModelLearningPlan.model_json_schema()
    instructions = (
        "你是中文学习规划助手。根据用户填写的目标、基础和每天可用时间，制定具体可执行的学习计划。"
        "只返回符合 JSON schema 的 JSON，不包含 Markdown。章节名称简短，每项任务明确成果或练习。"
        "day_number 从 1 开始，必须覆盖每一个计划日；section_index 从 0 开始引用 sections。"
        "每一天所有任务的 minutes 之和不能超过用户的 daily_minutes；不要生成空名称或重复任务。"
        f"JSON schema：{json.dumps(schema, ensure_ascii=False)}"
    )
    data = ollama_request(settings, "/api/chat", {
        "model": settings.model, "stream": False, "think": False, "format": schema,
        "options": {"temperature": 0, "num_predict": 8192},
        "messages": [{"role": "system", "content": instructions},
                     {"role": "user", "content": request.model_dump_json()}],
    })
    try:
        if data.get('done') is False or data.get('done_reason') == 'length':
            raise ValueError("模型输出未完成，请缩短计划天数后重试")
        result = ModelLearningPlan.model_validate_json(data['message']['content'])
        if {task.day_number for task in result.tasks} != set(range(1, request.days + 1)):
            raise ValueError("模型没有完整覆盖计划天数，请重新生成或缩短天数")
        return LearningPreview(
            name=result.name, goal=result.goal, sections=result.sections,
            start_date=request.start_date, target_date=request.start_date + timedelta(days=request.days - 1),
            daily_minutes=request.daily_minutes,
            tasks=[PreviewTask(plan_date=request.start_date + timedelta(days=task.day_number - 1),
                               **task.model_dump(exclude={'day_number'})) for task in result.tasks],
        )
    except (ValidationError, KeyError, TypeError, ValueError) as exc:
        detail = exc.errors()[0]['msg'] if isinstance(exc, ValidationError) else str(exc)
        raise HTTPException(502, f"生成的学习计划未通过校验：{detail}。尚未写入学习计划，可重新生成。") from exc
