"""Server-timed learning focus sessions and per-day totals."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import select

from .utils import active_record
from ..models import LearningGoal, LearningTask, StudyFocusSession, utc_now

router = APIRouter(prefix="/learning/focus", tags=["learning"])


class FocusStart(BaseModel):
    goal_id: str
    task_id: str | None = None


def aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def focus_today(session, offset_minutes: int) -> dict:
    now = utc_now()
    local_zone = timezone(timedelta(minutes=-offset_minutes))
    local_today = now.astimezone(local_zone).date()
    start = datetime.combine(local_today, time.min, local_zone).astimezone(timezone.utc)
    end = start + timedelta(days=1)
    rows = session.scalars(select(StudyFocusSession).where(
        StudyFocusSession.started_at < end,
    ).order_by(StudyFocusSession.started_at.desc())).all()
    total = 0
    for row in rows:
        actual_end = aware(row.ended_at) if row.ended_at else now
        begin = max(aware(row.started_at), start)
        finish = min(actual_end, end)
        total += max(0, int((finish - begin).total_seconds()))
    running = next((row for row in rows if row.ended_at is None), None)
    return {
        "date": local_today,
        "seconds": total,
        "running": {"id": running.id, "goal_id": running.goal_id, "task_id": running.task_id,
                    "started_at": aware(running.started_at)} if running else None,
    }


@router.get("/today")
def get_focus_today(request: Request, offset_minutes: int = Query(default=0, ge=-840, le=720)):
    with request.app.state.database.session() as session:
        return focus_today(session, offset_minutes)


@router.post("/start")
def start_focus(payload: FocusStart, request: Request):
    with request.app.state.data_lock, request.app.state.database.session() as session:
        active_record(session, LearningGoal, payload.goal_id, "学习目标")
        if payload.task_id:
            task = active_record(session, LearningTask, payload.task_id, "学习任务")
            if task.goal_id != payload.goal_id:
                raise HTTPException(422, "学习任务不属于当前目标")
        running = session.scalar(select(StudyFocusSession).where(StudyFocusSession.ended_at.is_(None)))
        if running:
            raise HTTPException(409, "已有正在进行的专注，请先结束")
        row = StudyFocusSession(goal_id=payload.goal_id, task_id=payload.task_id, started_at=utc_now())
        session.add(row)
        session.flush()
        return {"id": row.id, "started_at": row.started_at}


@router.post("/stop")
def stop_focus(request: Request):
    with request.app.state.data_lock, request.app.state.database.session() as session:
        running = session.scalar(select(StudyFocusSession).where(StudyFocusSession.ended_at.is_(None)))
        if not running:
            raise HTTPException(409, "当前没有正在进行的专注")
        running.ended_at = max(utc_now(), aware(running.started_at))
        session.flush()
        return {"id": running.id, "seconds": int((aware(running.ended_at) - aware(running.started_at)).total_seconds())}
