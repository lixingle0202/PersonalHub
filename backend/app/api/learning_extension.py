"""Learning-only reminder and date extension after three idle calendar days."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .learning import linked_task_agendas
from ..models import AgendaItem, LearningAutoExtension, LearningGoal, LearningTask, utc_now


router = APIRouter(prefix="/learning", tags=["learning"])


def current_day() -> date:
    """Use the host's local calendar day; callers can supply a clock in tests."""
    return date.today()


def local_day(value: datetime) -> date:
    # SQLite stores timezone-aware UTC timestamps without their offset.
    aware = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return aware.astimezone().date()


def completion_day(item: AgendaItem) -> date:
    return local_day(item.completed_at) if item.completed_at else item.plan_date


def pending_notices(session: Session) -> list[dict]:
    rows = session.execute(select(LearningAutoExtension, LearningGoal).join(
        LearningGoal, LearningGoal.id == LearningAutoExtension.goal_id,
    ).where(
        LearningAutoExtension.acknowledged_at.is_(None),
        LearningGoal.deleted_at.is_(None),
        LearningGoal.archived_at.is_(None),
    ).order_by(LearningAutoExtension.triggered_on.desc())).all()
    return [{
        "id": notice.id,
        "goal_id": goal.id,
        "goal_name": goal.name,
        "triggered_on": notice.triggered_on,
        "shifted_days": notice.shifted_days,
        "previous_first_date": notice.previous_first_date,
        "new_first_date": notice.new_first_date,
    } for notice, goal in rows]


def extend_idle_goals(session: Session, today: date) -> list[str]:
    cutoff = today - timedelta(days=3)
    shifted: list[str] = []
    goals = session.scalars(select(LearningGoal).where(
        LearningGoal.deleted_at.is_(None), LearningGoal.archived_at.is_(None),
    )).all()
    for goal in goals:
        if goal.progress_override == 100:
            continue
        if session.scalar(select(LearningAutoExtension.id).where(
            LearningAutoExtension.goal_id == goal.id,
            LearningAutoExtension.triggered_on == today,
        )):
            continue
        tasks = session.scalars(select(LearningTask).where(
            LearningTask.goal_id == goal.id, LearningTask.deleted_at.is_(None),
        )).all()
        agendas = [item for item in linked_task_agendas(session, tasks) if item.deleted_at is None]
        pending = [item for item in agendas if item.status == "pending"]
        overdue = [item.plan_date for item in pending if item.plan_date < today]
        if not overdue:
            continue
        oldest_due = min(overdue)
        completed = [completion_day(item) for item in agendas if item.status == "completed"]
        # A completed task today or during the previous three days breaks the idle streak.
        if any(day >= cutoff for day in completed):
            continue
        idle_start = max(oldest_due, local_day(goal.created_at))
        if completed:
            idle_start = max(idle_start, max(completed) + timedelta(days=1))
        if idle_start > cutoff:
            continue

        shift = (today - oldest_due).days
        for item in pending:
            item.plan_date += timedelta(days=shift)
        if goal.target_date:
            goal.target_date += timedelta(days=shift)
        if goal.start_date and not completed:
            goal.start_date += timedelta(days=shift)
        session.add(LearningAutoExtension(
            goal_id=goal.id, triggered_on=today, shifted_days=shift,
            previous_first_date=oldest_due, new_first_date=today,
        ))
        shifted.append(goal.id)
    session.flush()
    return shifted


@router.post("/overdue/check")
def check_overdue(request: Request):
    # The same user's page may open in several tabs. Commit while holding the lock.
    with request.app.state.data_lock, request.app.state.database.session() as session:
        shifted = extend_idle_goals(session, current_day())
        return {"shifted_goal_ids": shifted, "notices": pending_notices(session)}


@router.post("/overdue/reminders/{reminder_id}/ack")
def acknowledge_reminder(reminder_id: str, request: Request):
    with request.app.state.data_lock, request.app.state.database.session() as session:
        reminder = session.get(LearningAutoExtension, reminder_id)
        if not reminder:
            raise HTTPException(404, "学习计划提醒不存在")
        goal = session.get(LearningGoal, reminder.goal_id)
        if not goal or goal.deleted_at is not None:
            raise HTTPException(404, "学习计划提醒不存在")
        if reminder.acknowledged_at is None:
            reminder.acknowledged_at = utc_now()
        session.flush()
        return {"acknowledged": True}
