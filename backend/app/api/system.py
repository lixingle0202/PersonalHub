from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from .deps import get_session
from ..models import (
    AgendaItem, Consultation, DevIssue, DevProject, DevTask, Dish,
    DailyActivity, LearningGoal, MediaContent, QuickNote, Setting,
)
from ..services.data_safety import create_backup, list_backups, resolve_backup, restore_backup
from ..services.trash import list_trash, purge_trash, restore_category, restore_trash
from ..services.search_assistant import CATEGORIES, parse_query, search_and_compare


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
        AgendaItem.deleted_at.is_(None),
        AgendaItem.module != "games",
        or_(AgendaItem.source_type.is_(None), AgendaItem.source_type != "game_plan"),
        or_(AgendaItem.title.ilike(pattern), AgendaItem.notes.ilike(pattern)),
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
    ]
    for model, module, label, title_col, text_col, path in resources:
        rows = session.scalars(select(model).where(
            model.deleted_at.is_(None), or_(title_col.ilike(pattern), text_col.ilike(pattern))
        ).limit(20)).all()
        for row in rows:
            title = getattr(row, title_col.key)
            text = getattr(row, text_col.key) or ""
            results.append({"id": row.id, "module": module, "type": label, "title": title, "snippet": snippet(text, q), "path": path + row.id})
    for note in session.scalars(select(QuickNote).where(
        QuickNote.deleted_at.is_(None), QuickNote.is_archived.is_(False), QuickNote.content.contains(q, autoescape=True),
    ).limit(20)):
        results.append({"id": note.id, "module": "home", "type": "备忘", "title": note.content[:100], "snippet": snippet(note.content, q), "path": f"/?note={note.id}#quick-notes"})
    for activity in session.scalars(select(DailyActivity).where(
        DailyActivity.deleted_at.is_(None), DailyActivity.content.contains(q, autoescape=True),
    ).limit(20)):
        results.append({"id": activity.id, "module": "home", "type": "日常记录", "title": activity.content[:100], "snippet": snippet(activity.content, q), "path": f"/?date={activity.activity_date}&activity={activity.id}#daily-activities"})
    return results[:50]


@router.get("/search/assist")
def assisted_search(
    q: str = Query(min_length=1, max_length=200),
    today: date | None = None,
    offset_minutes: int = Query(default=0, ge=-840, le=720),
    start_date: date | None = None,
    end_date: date | None = None,
    all_dates: bool = False,
    category: str | None = None,
    status_filter: Literal["all", "pending", "completed"] | None = None,
    keyword: str | None = Query(default=None, max_length=200),
    mode: Literal["search", "compare"] | None = None,
    session: Session = Depends(get_session),
):
    try:
        anchor = today or date.today()
        intent = parse_query(q, anchor)
        if start_date is not None or end_date is not None:
            intent.start_date, intent.end_date = start_date, end_date
        if all_dates:
            intent.start_date = intent.end_date = None
        if category is not None:
            if category not in CATEGORIES:
                raise ValueError("不支持的类别")
            intent.category = category
        if status_filter is not None:
            intent.status = status_filter
        if keyword is not None:
            intent.keyword = keyword.strip()
        if mode is not None:
            intent.mode = mode
        if intent.mode == "compare" and intent.start_date is None and not all_dates:
            intent.start_date = anchor - timedelta(days=anchor.weekday())
            intent.end_date = intent.start_date + timedelta(days=6)
        return search_and_compare(session, intent, anchor, offset_minutes)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


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


@router.post("/trash/categories/{module}/restore")
def restore_deleted_category(module: str, session: Session = Depends(get_session)):
    try:
        result = restore_category(session, module)
        session.commit()
        return result
    except (KeyError, LookupError) as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/trash/{item_type}/{item_id}/restore")
def restore_deleted(item_type: str, item_id: str, session: Session = Depends(get_session)):
    try:
        result = restore_trash(session, item_type, item_id)
        session.commit()
        return result
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.delete("/trash/{item_type}/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def purge_deleted(item_type: str, item_id: str, session: Session = Depends(get_session)):
    try:
        purge_trash(session, item_type, item_id)
        session.commit()
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)
