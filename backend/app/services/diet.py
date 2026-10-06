from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..api.utils import soft_delete
from ..models import AgendaItem, MealPlan


def delete_meal_plan(session: Session, meal: MealPlan) -> None:
    """Hide a meal and every linked agenda, including legacy source links."""
    soft_delete(meal)
    agendas = session.scalars(select(AgendaItem).where(or_(
        AgendaItem.id == meal.agenda_id,
        (AgendaItem.source_type == "meal_plan") & (AgendaItem.source_id == meal.id),
    ))).all()
    for agenda in agendas:
        agenda.deleted_at = meal.deleted_at
    session.flush()
