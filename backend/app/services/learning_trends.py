"""Calendar-day learning evidence; manual logs and timers remain independent."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import LearningGoal, LearningTask, StudyFocusSession, StudySession
from .learning_links import linked_task_agendas


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _streak(spans: list[tuple[date, date]], today: date) -> int:
    """Merge active days, including history outside the selected chart range."""
    merged: list[tuple[date, date]] = []
    for start, end in sorted(spans):
        if merged and (start - merged[-1][1]).days <= 1:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    if not merged or (today - merged[-1][1]).days > 1:
        return 0
    return (merged[-1][1] - merged[-1][0]).days + 1


def learning_trends(session: Session, today: date, days: int, offset_minutes: int, goal_id: str | None) -> dict:
    first = today - timedelta(days=days - 1)
    zone = timezone(timedelta(minutes=-offset_minutes))  # Browser getTimezoneOffset convention.
    def midnight(day: date) -> datetime:
        return datetime.combine(day, time.min, zone).astimezone(timezone.utc)
    range_start, range_end = midnight(first), midnight(today + timedelta(days=1))
    dates = [first + timedelta(days=index) for index in range(days)]
    rows = {day: {"date": day.isoformat(), "manual_minutes": None, "focus_seconds": None,
                  "planned_tasks": 0, "completed_tasks": 0} for day in dates}
    goals = select(LearningGoal.id).where(
        LearningGoal.deleted_at.is_(None), LearningGoal.archived_at.is_(None),
    )
    if goal_id:
        goals = goals.where(LearningGoal.id == goal_id)

    manual_spans: list[tuple[date, date]] = []
    manual_count = 0
    for log in session.scalars(select(StudySession).where(
        StudySession.goal_id.in_(goals), StudySession.deleted_at.is_(None),
        StudySession.archived_at.is_(None), StudySession.studied_on <= today,
    )):
        minutes = max(0, log.actual_minutes)
        if minutes > 0:
            manual_spans.append((log.studied_on, log.studied_on))
        if log.studied_on in rows:
            row = rows[log.studied_on]
            row["manual_minutes"] = (row["manual_minutes"] or 0) + minutes
            manual_count += 1

    active_tasks = list(session.scalars(select(LearningTask).where(
        LearningTask.goal_id.in_(goals), LearningTask.deleted_at.is_(None),
        LearningTask.archived_at.is_(None),
    )))
    task_ids = {task.id for task in active_tasks}
    focus_spans: list[tuple[date, date]] = []
    focus_count = 0
    for timer in session.scalars(select(StudyFocusSession).where(
        StudyFocusSession.goal_id.in_(goals), StudyFocusSession.ended_at.is_not(None),
        StudyFocusSession.started_at < range_end,
    )):
        if timer.task_id and timer.task_id not in task_ids:
            continue
        start, end = _aware(timer.started_at), min(_aware(timer.ended_at), range_end)
        if end <= start:
            continue
        focus_spans.append((start.astimezone(zone).date(), (end - timedelta(microseconds=1)).astimezone(zone).date()))
        if end <= range_start:
            continue
        focus_count += 1
        # Only iterate the visible window, even for long intervals.
        for day in dates:
            begin, finish = max(start, midnight(day)), min(end, midnight(day + timedelta(days=1)))
            seconds = max(0.0, (finish - begin).total_seconds())
            if seconds > 0:
                rows[day]["focus_seconds"] = (rows[day]["focus_seconds"] or 0) + seconds

    agendas = [agenda for agenda in linked_task_agendas(session, active_tasks)
               if agenda.deleted_at is None and agenda.archived_at is None]
    by_id = {agenda.id: agenda for agenda in agendas}
    by_source = {agenda.source_id: agenda for agenda in sorted(agendas, key=lambda item: item.id)
                 if agenda.source_type == "learning_task" and agenda.source_id in task_ids}
    for task in active_tasks:
        agenda = by_id.get(task.agenda_id)
        if agenda and agenda.source_type == "learning_task" and agenda.source_id not in {None, task.id}:
            agenda = None  # A stale forward link must not count another task twice.
        agenda = agenda or by_source.get(task.id)
        if agenda and agenda.plan_date in rows and agenda.status in {"pending", "completed"}:
            rows[agenda.plan_date]["planned_tasks"] += 1
            rows[agenda.plan_date]["completed_tasks"] += int(agenda.status == "completed")

    result = list(rows.values())
    for row in result:
        if row["focus_seconds"] is not None:
            row["focus_seconds"] = round(row["focus_seconds"], 3)
    planned = sum(row["planned_tasks"] for row in result)
    completed = sum(row["completed_tasks"] for row in result)
    return {
        "start_date": first.isoformat(), "end_date": today.isoformat(), "days": result,
        "manual": {"minutes": sum(row["manual_minutes"] or 0 for row in result),
                   "record_count": manual_count, "active_days": sum((row["manual_minutes"] or 0) > 0 for row in result),
                   "current_streak": _streak(manual_spans, today)},
        "focus": {"minutes": sum(row["focus_seconds"] or 0 for row in result) / 60,
                  "record_count": focus_count, "active_days": sum((row["focus_seconds"] or 0) > 0 for row in result),
                  "current_streak": _streak(focus_spans, today)},
        "tasks": {"planned": planned, "completed": completed,
                  "completion_rate": round(completed * 100 / planned, 1) if planned else None},
    }
