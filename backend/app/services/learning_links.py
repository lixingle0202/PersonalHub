from __future__ import annotations

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..models import AgendaItem, LearningTask


def linked_task_agendas(session: Session, tasks: list[LearningTask]) -> list[AgendaItem]:
    """Find forward and legacy reverse links without changing another source's agenda."""
    if not tasks:
        return []
    task_ids = [task.id for task in tasks]
    agenda_ids = [task.agenda_id for task in tasks if task.agenda_id]
    owns_source = (AgendaItem.source_type == "learning_task") & AgendaItem.source_id.in_(task_ids)
    legacy_forward = AgendaItem.id.in_(agenda_ids) & or_(
        AgendaItem.source_type.is_(None),
        (AgendaItem.source_type == "learning_task") & AgendaItem.source_id.is_(None),
    )
    return list(session.scalars(select(AgendaItem).where(or_(owns_source, legacy_forward))).all())
