"""Generate editable meal-template drafts with the configured Ollama model."""
from __future__ import annotations

import json
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from .ai import generation_config
from .diet_templates import TemplateIn
from ..services.ollama import ollama_request

router = APIRouter(prefix="/ai/diet", tags=["local-ai"])


class DietGenerateRequest(BaseModel):
    theme: str = Field(min_length=1, max_length=200)
    preferences: str = Field(default="", max_length=1000)
    days: int = Field(default=1, ge=1, le=7)


class VisitorDietResult(BaseModel):
    requirements: DietGenerateRequest
    content: str = Field(min_length=1, max_length=120_000)
    done: bool | None = None
    done_reason: str | None = None


def diet_chat_payload(request: DietGenerateRequest) -> dict:
    schema = {
        "type": "object", "additionalProperties": False,
        "properties": {
            "name": {"type": "string", "minLength": 1, "maxLength": 200},
            "description": {"type": "string", "maxLength": 2000},
            "meals": {"type": "array", "prefixItems": [], "minItems": request.days * 3, "maxItems": request.days * 3},
        }, "required": ["name", "description", "meals"],
    }
    for day in range(1, request.days + 1):
        for meal_type in ("breakfast", "lunch", "dinner"):
            schema["properties"]["meals"]["prefixItems"].append({
                "type": "object", "additionalProperties": False,
                "properties": {
                    "day_number": {"type": "integer", "enum": [day]},
                    "meal_type": {"type": "string", "enum": [meal_type]},
                    "name": {"type": "string", "minLength": 1, "maxLength": 200},
                    "estimated_kcal": {"type": "integer", "minimum": 100, "maximum": 1200},
                }, "required": ["day_number", "meal_type", "name", "estimated_kcal"],
            })
    instructions = (
        "你是中文饮食规划助手。只返回 JSON，为每一天提供早餐、午餐、晚餐各一项，包含具体菜名和粗略 kcal。"
        "食物建议应多样化，不要承诺减肥或治疗疾病，不要生成极低热量菜单。"
        "热量只是估算，用户会在导入前核对份量、食材和过敏信息。"
        f"共 {request.days} 天；meals 按天依次为 breakfast、lunch、dinner，共 {request.days * 3} 项。"
    )
    return {"stream": False, "think": False, "format": schema,
            "options": {"temperature": 0.2, "num_predict": 4096},
            "messages": [{"role": "system", "content": instructions},
                         {"role": "user", "content": request.model_dump_json()}]}


def diet_preview(request: DietGenerateRequest, data: dict) -> dict:
    try:
        if data.get("done") is False or data.get("done_reason") == "length":
            raise ValueError("模型输出未完成，请缩短周期重试")
        content = json.loads(data["message"]["content"])
        template = TemplateIn.model_validate({**content, "cycle_days": request.days})
        expected = {(day, kind) for day in range(1, request.days + 1) for kind in ("breakfast", "lunch", "dinner")}
        if {(meal.day_number, meal.meal_type) for meal in template.meals} != expected:
            raise ValueError("模型没有完整生成每天的三餐")
        return template.model_dump()
    except (ValidationError, ValueError, KeyError, TypeError) as exc:
        detail = exc.errors()[0]["msg"] if isinstance(exc, ValidationError) else str(exc)
        raise HTTPException(502, f"生成的菜谱未通过校验：{detail}。尚未导入饮食日历，请重试。") from exc


@router.post("/generate")
def generate_diet(payload: DietGenerateRequest, request: Request):
    with request.app.state.database.session() as session:
        config = generation_config(request, session)
    if not config.model:
        raise HTTPException(422, "请先在数据与设置中选择并保存大模型")
    result = ollama_request(config, "/api/chat", {"model": config.model, **diet_chat_payload(payload)})
    return {"plan": diet_preview(payload, result)}


@router.post("/visitor/prepare")
def prepare_visitor_diet(payload: DietGenerateRequest):
    return diet_chat_payload(payload)


@router.post("/visitor/draft")
def validate_visitor_diet(payload: VisitorDietResult):
    return {"plan": diet_preview(payload.requirements, {"message": {"content": payload.content},
                                                         "done": payload.done, "done_reason": payload.done_reason})}
