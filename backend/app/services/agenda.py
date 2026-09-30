from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import AgendaItem, DevTask, MediaContent


def sync_source_from_agenda(session: Session, item: AgendaItem) -> None:
    if item.source_type == "dev_task" and item.source_id:
        task = session.get(DevTask, item.source_id)
        if task:
            if item.status == "completed":
                task.workflow_status = "done"
            elif item.status == "pending" and task.workflow_status == "done":
                task.workflow_status = "todo"
    elif item.source_type == "media_content" and item.source_id:
        content = session.get(MediaContent, item.source_id)
        if content:
            if item.status == "completed":
                content.stage = "published"
                content.published_at = content.published_at or item.plan_date
            elif item.status == "pending" and content.stage == "published":
                content.stage = "ready"


def set_agenda_status(session: Session, item: AgendaItem, status: str) -> AgendaItem:
    item.status = status
    item.completed_at = datetime.now(timezone.utc) if status == "completed" else None
    sync_source_from_agenda(session, item)
    session.flush()
    return item


def agenda_for_source(session: Session, source_type: str, source_id: str) -> AgendaItem | None:
    return session.scalar(
        select(AgendaItem).where(
            AgendaItem.source_type == source_type,
            AgendaItem.source_id == source_id,
            AgendaItem.deleted_at.is_(None),
        )
    )
