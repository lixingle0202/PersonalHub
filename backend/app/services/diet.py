from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..api.utils import soft_delete
from ..models import AgendaItem, Dish, MealPlan, MealPlanDish


def meal_dish_ids(session: Session, meal: MealPlan) -> list[str]:
    ids = session.scalars(select(MealPlanDish.dish_id).where(
        MealPlanDish.meal_id == meal.id
    ).order_by(MealPlanDish.position)).all()
    return list(ids) if ids else ([meal.dish_id] if meal.dish_id else [])


def meal_dishes(session: Session, meal: MealPlan) -> list[Dish]:
    return [dish for dish_id in meal_dish_ids(session, meal)
            if (dish := session.get(Dish, dish_id)) is not None]


def meal_display_name(session: Session, meal: MealPlan) -> str:
    names = [dish.name for dish in meal_dishes(session, meal)]
    return "、".join(names) if names else meal.custom_name


def replace_meal_dishes(session: Session, meal: MealPlan, dish_ids: list[str]) -> None:
    existing = {item.dish_id: item for item in session.scalars(select(MealPlanDish).where(
        MealPlanDish.meal_id == meal.id
    )).all()}
    for dish_id, item in existing.items():
        if dish_id not in dish_ids:
            session.delete(item)
    for position, dish_id in enumerate(dish_ids):
        if dish_id in existing:
            existing[dish_id].position = position
        else:
            session.add(MealPlanDish(meal_id=meal.id, dish_id=dish_id, position=position))
    meal.dish_id = dish_ids[0] if dish_ids else None


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
