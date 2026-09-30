from __future__ import annotations

import json
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from .deps import get_session
from ..models import (
    AgendaItem, Consultation, DevIssue, DevProject, DevTask, Dish, Game,
    LearningGoal, MediaContent, Setting,
)
from ..services.data_safety import create_backup, list_backups, resolve_backup, restore_backup
from ..services.trash import list_trash, purge_trash, restore_trash


router = APIRouter(tags=["system"])


DEFAULT_SETTINGS: dict[str, Any] = {
    "nickname": "",
    "theme_mode": "light",
    "theme_color": "#5b6cff",
    "week_starts_on": 1,
    "default_work_start": "09:00",
    "default_work_end": "18:00",
    "default_study_minutes": 60,
    "custom_categories": {},
}


class SettingsPatch(BaseModel):
    nickname: str | None = Field(default=None, max_length=100)
    theme_mode: Literal["light", "dark"] | None = None
    theme_color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    week_starts_on: Literal[0, 1] | None = None
    default_work_start: str | None = None
    default_work_end: str | None = None
    default_study_minutes: int | None = Field(default=None, ge=0, le=1440)
    custom_categories: dict[str, list[str]] | None = None


def read_settings(session: Session) -> dict[str, Any]:
    values = dict(DEFAULT_SETTINGS)
    for setting in session.scalars(select(Setting)).all():
        try:
            values[setting.key] = json.loads(setting.value_json)
        except json.JSONDecodeError:
            continue
    return values


@router.get("/settings")
def get_settings(session: Session = Depends(get_session)):
    return read_settings(session)


@router.patch("/settings")
def patch_settings(payload: SettingsPatch, session: Session = Depends(get_session)):
    for key, value in payload.model_dump(exclude_unset=True).items():
        setting = session.get(Setting, key)
        if not setting:
            setting = Setting(key=key, value_json=json.dumps(value, ensure_ascii=False)); session.add(setting)
        else:
            setting.value_json = json.dumps(value, ensure_ascii=False)
    session.flush()
    return read_settings(session)


def snippet(text: str, query: str, width: int = 80) -> str:
    clean = text.replace("\n", " ").strip()
    index = clean.lower().find(query.lower())
    if index < 0:
        return clean[:width]
    start = max(0, index - 20)
    return clean[start:start + width]


@router.get("/search")
def search(q: str = Query(min_length=1, max_length=100), session: Session = Depends(get_session)):
    pattern = f"%{q}%"
    results: list[dict[str, str]] = []

    for item in session.scalars(select(AgendaItem).where(
        AgendaItem.deleted_at.is_(None), or_(AgendaItem.title.ilike(pattern), AgendaItem.notes.ilike(pattern))
    ).limit(20)).all():
        results.append({"id": item.id, "module": "today", "type": "计划", "title": item.title, "snippet": snippet(item.notes, q), "path": f"/today?date={item.plan_date.isoformat()}"})

    resources = [
        (MediaContent, "media", "自媒体", MediaContent.title, MediaContent.body, "/media?item="),
        (DevProject, "development", "开发项目", DevProject.name, DevProject.description, "/development?project="),
        (DevTask, "development", "开发任务", DevTask.title, DevTask.description, "/development?task="),
        (DevIssue, "development", "开发问题", DevIssue.title, DevIssue.resolution, "/development?issue="),
        (Consultation, "consulting", "咨询", Consultation.title, Consultation.original_question, "/consulting?item="),
        (LearningGoal, "learning", "学习目标", LearningGoal.name, LearningGoal.goal, "/learning?item="),
        (Dish, "diet", "菜品", Dish.name, Dish.instructions, "/diet?dish="),
        (Game, "games", "游戏", Game.name, Game.notes, "/games?item="),
    ]
    for model, module, label, title_col, text_col, path in resources:
        rows = session.scalars(select(model).where(
            model.deleted_at.is_(None), or_(title_col.ilike(pattern), text_col.ilike(pattern))
        ).limit(20)).all()
        for row in rows:
            title = getattr(row, title_col.key)
            text = getattr(row, text_col.key) or ""
            results.append({"id": row.id, "module": module, "type": label, "title": title, "snippet": snippet(text, q), "path": path + row.id})
    return results[:50]


@router.get("/backups")
def backups(request: Request):
    return list_backups(request.app.state.settings.backup_path)


@router.post("/backups", status_code=status.HTTP_201_CREATED)
def make_backup(request: Request):
    with request.app.state.data_lock:
        try:
            return create_backup(
                request.app.state.settings.database_path,
                request.app.state.settings.backup_path,
                "manual",
            )
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc


@router.post("/backups/{filename}/restore")
def restore(filename: str, request: Request):
    with request.app.state.data_lock:
        try:
            backup_path = resolve_backup(request.app.state.settings.backup_path, filename)
            replacement, pre_restore = restore_backup(
                request.app.state.database,
                backup_path,
                request.app.state.settings.backup_path,
            )
            request.app.state.database = replacement
            return {"restored": filename, "pre_restore_backup": pre_restore}
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc


@router.get("/trash")
def trash(session: Session = Depends(get_session)):
    return list_trash(session)


@router.post("/trash/{item_type}/{item_id}/restore")
def restore_deleted(item_type: str, item_id: str, session: Session = Depends(get_session)):
    try:
        return restore_trash(session, item_type, item_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.delete("/trash/{item_type}/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def purge_deleted(item_type: str, item_id: str, session: Session = Depends(get_session)):
    try:
        purge_trash(session, item_type, item_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)
