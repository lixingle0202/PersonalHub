"""Recurring meal templates and non-destructive calendar import."""
from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from .deps import get_session
from .diet import MEAL_NAMES
from .utils import active_record, soft_delete
from ..models import AgendaItem, DietTemplate, MealPlan, new_id

router = APIRouter(prefix="/diet/templates", tags=["diet"])


class TemplateMeal(BaseModel):
    day_number: int = Field(ge=1, le=14)
    meal_type: Literal["breakfast", "lunch", "dinner", "snack"]
    name: str = Field(min_length=1, max_length=200)
    estimated_kcal: int = Field(ge=1, le=3000)


class TemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    cycle_days: int = Field(ge=1, le=14)
    meals: list[TemplateMeal] = Field(min_length=1, max_length=56)

    @model_validator(mode="after")
    def validate_days(self):
        if {meal.day_number for meal in self.meals} != set(range(1, self.cycle_days + 1)):
            raise ValueError("模板每一天都需要至少一餐")
        keys = [(meal.day_number, meal.meal_type) for meal in self.meals]
        if len(keys) != len(set(keys)):
            raise ValueError("模板同一天不能重复安排同一餐次")
        return self


class TemplateImport(BaseModel):
    start_date: date
    days: int = Field(default=7, ge=1, le=31)


def preset(name: str, description: str, rows: list[list[tuple[str, str, int]]]) -> dict:
    return {"id": f"preset:{len(name)}:{name}", "name": name, "description": description,
            "cycle_days": len(rows), "builtin": True,
            "meals": [{"day_number": day, "meal_type": kind, "name": food, "estimated_kcal": kcal}
                      for day, entries in enumerate(rows, 1) for kind, food, kcal in entries]}


PRESETS = [
    preset("减脂餐模板", "三日循环示例；热量只是粗估，需结合个人需要调整份量。", [
        [("breakfast", "燕麦牛奶与鸡蛋", 390), ("lunch", "鸡胸肉杂粮饭与西兰花", 620), ("dinner", "清蒸鱼、米饭与时蔬", 580)],
        [("breakfast", "全麦面包、酸奶与香蕉", 410), ("lunch", "番茄牛肉饭与青菜", 650), ("dinner", "豆腐鸡蛋汤与米饭", 570)],
        [("breakfast", "鸡蛋、牛奶与水果", 380), ("lunch", "虾仁蔬菜饭", 630), ("dinner", "鸡肉蔬菜面", 600)],
    ]),
    preset("备考周饮食模板", "三日循环示例；规律用餐，按食量和实际食材调整。", [
        [("breakfast", "鸡蛋、燕麦粥与牛奶", 450), ("lunch", "番茄炒蛋、米饭与青菜", 700), ("dinner", "鱼肉蔬菜面", 650)],
        [("breakfast", "全麦三明治与酸奶", 460), ("lunch", "鸡肉杂粮饭与蔬菜", 720), ("dinner", "豆腐牛肉汤与米饭", 660)],
        [("breakfast", "小米粥、鸡蛋与香蕉", 430), ("lunch", "虾仁炒饭与蔬菜", 710), ("dinner", "清蒸鱼、米饭与青菜", 650)],
    ]),
    preset("养胃饮食模板", "清淡三日循环示例，不用于治疗胃部疾病；按耐受情况调整。", [
        [("breakfast", "小米粥与蒸蛋", 390), ("lunch", "鸡肉软饭与熟蔬菜", 630), ("dinner", "鱼片粥与豆腐", 570)],
        [("breakfast", "燕麦粥与香蕉", 400), ("lunch", "清蒸鱼、米饭与胡萝卜", 650), ("dinner", "鸡蛋汤面与熟青菜", 590)],
        [("breakfast", "南瓜粥与鸡蛋", 390), ("lunch", "鸡肉土豆饭", 650), ("dinner", "豆腐蔬菜粥", 560)],
    ]),
]


def template_out(row: DietTemplate) -> dict:
    return {"id": row.id, "name": row.name, "description": row.description,
            "cycle_days": row.cycle_days, "meals": json.loads(row.meals_json), "builtin": False}


def find_template(session: Session, template_id: str) -> dict:
    builtin = next((item for item in PRESETS if item["id"] == template_id), None)
    if builtin:
        return builtin
    return template_out(active_record(session, DietTemplate, template_id, "饮食模板"))


@router.get("")
def list_templates(session: Session = Depends(get_session)):
    rows = session.scalars(select(DietTemplate).where(
        DietTemplate.deleted_at.is_(None), DietTemplate.archived_at.is_(None)
    ).order_by(DietTemplate.created_at.desc())).all()
    return [*PRESETS, *(template_out(row) for row in rows)]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_template(payload: TemplateIn, session: Session = Depends(get_session)):
    row = DietTemplate(name=payload.name, description=payload.description,
                       cycle_days=payload.cycle_days,
                       meals_json=json.dumps([meal.model_dump() for meal in payload.meals], ensure_ascii=False))
    session.add(row); session.flush()
    return template_out(row)


@router.patch("/{template_id}")
def update_template(template_id: str, payload: TemplateIn, session: Session = Depends(get_session)):
    row = active_record(session, DietTemplate, template_id, "饮食模板")
    row.name = payload.name; row.description = payload.description; row.cycle_days = payload.cycle_days
    row.meals_json = json.dumps([meal.model_dump() for meal in payload.meals], ensure_ascii=False)
    session.flush()
    return template_out(row)


@router.delete("/{template_id}")
def delete_template(template_id: str, session: Session = Depends(get_session)):
    row = active_record(session, DietTemplate, template_id, "饮食模板")
    soft_delete(row); session.flush()
    return {"deleted": True}


@router.post("/{template_id}/import")
def import_template(template_id: str, payload: TemplateImport, request: Request):
    with request.app.state.data_lock, request.app.state.database.session() as session:
        template = find_template(session, template_id)
        end = payload.start_date + timedelta(days=payload.days - 1)
        occupied = {(item.meal_date, item.meal_type) for item in session.scalars(select(MealPlan).where(
            MealPlan.meal_date >= payload.start_date, MealPlan.meal_date <= end,
            MealPlan.deleted_at.is_(None),
        )).all()}
        meals_by_day: dict[int, list[dict]] = {}
        for item in template["meals"]:
            meals_by_day.setdefault(item["day_number"], []).append(item)
        added = skipped = 0
        for offset in range(payload.days):
            meal_date = payload.start_date + timedelta(days=offset)
            for item in meals_by_day[(offset % template["cycle_days"]) + 1]:
                key = (meal_date, item["meal_type"])
                if key in occupied:
                    skipped += 1
                    continue
                occupied.add(key)
                meal = MealPlan(id=new_id(), meal_date=meal_date, meal_type=item["meal_type"],
                                custom_name=item["name"], estimated_kcal=item["estimated_kcal"])
                session.add(meal)
                agenda = AgendaItem(title=f"{MEAL_NAMES[item['meal_type']]}：{item['name']}",
                                    plan_date=meal_date, module="diet", source_type="meal_plan", source_id=meal.id,
                                    notes=f"饮食模板：{template['name']}\n约 {item['estimated_kcal']} kcal")
                session.add(agenda); session.flush(); meal.agenda_id = agenda.id
                added += 1
        return {"imported": added, "skipped": skipped, "start_date": payload.start_date, "end_date": end}
