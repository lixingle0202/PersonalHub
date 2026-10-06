from __future__ import annotations

from collections import defaultdict
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from .deps import get_session
from .utils import active_record, apply_changes, model_dict, soft_delete
from ..services.diet import delete_meal_plan
from ..models import (
    AgendaItem, DailyHealthLog, Dish, DishIngredient, MealPlan, ShoppingItem,
    ShoppingList, new_id,
)


router = APIRouter(prefix="/diet", tags=["diet"])


class IngredientIn(BaseModel):
    name: str = Field(min_length=1)
    quantity: float | None = Field(default=None, ge=0)
    unit: str = ""


class DishIn(BaseModel):
    name: str = Field(min_length=1)
    instructions: str = ""
    nutrition_notes: str = ""
    notes: str = ""
    ingredients: list[IngredientIn] = []


class MealIn(BaseModel):
    meal_date: date
    meal_type: Literal["breakfast", "lunch", "dinner", "snack"]
    dish_id: str | None = None
    custom_name: str = ""
    actual_food: str = ""


class HealthIn(BaseModel):
    water_ml: int = Field(default=0, ge=0)
    weight_kg: float | None = Field(default=None, gt=0)
    feeling: str = ""


class ShoppingGenerate(BaseModel):
    name: str = Field(min_length=1)
    start_date: date
    end_date: date


class ShoppingItemPatch(BaseModel):
    is_completed: bool | None = None
    quantity_text: str | None = None


MEAL_NAMES = {"breakfast": "早餐", "lunch": "午餐", "dinner": "晚餐", "snack": "加餐"}


def dish_out(session: Session, dish: Dish) -> dict:
    data = model_dict(dish)
    data["ingredients"] = [model_dict(item) for item in session.scalars(select(DishIngredient).where(
        DishIngredient.dish_id == dish.id
    ).order_by(DishIngredient.created_at)).all()]
    return data


def meal_out(session: Session, meal: MealPlan) -> dict:
    data = model_dict(meal)
    dish = session.get(Dish, meal.dish_id) if meal.dish_id else None
    agenda = session.get(AgendaItem, meal.agenda_id) if meal.agenda_id else None
    data.update(
        dish_name=dish.name if dish else meal.custom_name,
        status=agenda.status if agenda else None,
    )
    return data


@router.get("/dishes")
def list_dishes(session: Session = Depends(get_session)):
    return [dish_out(session, item) for item in session.scalars(select(Dish).where(
        Dish.deleted_at.is_(None), Dish.archived_at.is_(None)
    ).order_by(Dish.name)).all()]


@router.post("/dishes", status_code=status.HTTP_201_CREATED)
def create_dish(payload: DishIn, session: Session = Depends(get_session)):
    dish = Dish(**payload.model_dump(exclude={"ingredients"}))
    session.add(dish); session.flush()
    for ingredient in payload.ingredients:
        session.add(DishIngredient(dish_id=dish.id, **ingredient.model_dump()))
    session.flush()
    return dish_out(session, dish)


@router.get("/dishes/{dish_id}")
def get_dish(dish_id: str, session: Session = Depends(get_session)):
    return dish_out(session, active_record(session, Dish, dish_id, "菜品"))


@router.patch("/dishes/{dish_id}")
def update_dish(dish_id: str, payload: DishIn, session: Session = Depends(get_session)):
    dish = active_record(session, Dish, dish_id, "菜品")
    apply_changes(dish, payload.model_dump(exclude={"ingredients"}), {"name", "instructions", "nutrition_notes", "notes"})
    for item in session.scalars(select(DishIngredient).where(DishIngredient.dish_id == dish.id)).all():
        session.delete(item)
    for ingredient in payload.ingredients:
        session.add(DishIngredient(dish_id=dish.id, **ingredient.model_dump()))
    session.flush()
    return dish_out(session, dish)


@router.delete("/dishes/{dish_id}")
def delete_dish(dish_id: str, session: Session = Depends(get_session)):
    dish = active_record(session, Dish, dish_id, "菜品")
    soft_delete(dish); session.flush()
    return dish_out(session, dish)


@router.get("/meals")
def list_meals(start_date: date, end_date: date, session: Session = Depends(get_session)):
    meals = session.scalars(select(MealPlan).where(
        MealPlan.meal_date >= start_date, MealPlan.meal_date <= end_date,
        MealPlan.deleted_at.is_(None),
    ).order_by(MealPlan.meal_date, MealPlan.meal_type)).all()
    return [meal_out(session, meal) for meal in meals]


@router.post("/reset")
def reset_meal_plans(session: Session = Depends(get_session)):
    meals = session.scalars(select(MealPlan).where(MealPlan.deleted_at.is_(None))).all()
    meal_ids = [meal.id for meal in meals]
    agenda_ids = [meal.agenda_id for meal in meals if meal.agenda_id]
    agenda_conditions = []
    if agenda_ids:
        agenda_conditions.append(AgendaItem.id.in_(agenda_ids))
    if meal_ids:
        agenda_conditions.append(
            (AgendaItem.source_type == "meal_plan") & AgendaItem.source_id.in_(meal_ids)
        )
    agendas = session.scalars(select(AgendaItem).where(
        AgendaItem.deleted_at.is_(None), or_(*agenda_conditions)
    )).all() if agenda_conditions else []

    for item in [*meals, *agendas]:
        soft_delete(item)
    session.flush()
    return {"cancelled_meals": len(meals), "cancelled_agenda": len(agendas)}


@router.post("/meals", status_code=status.HTTP_201_CREATED)
def create_meal(payload: MealIn, session: Session = Depends(get_session)):
    if not payload.dish_id and not payload.custom_name.strip():
        raise HTTPException(422, "请选择菜品或填写餐食名称")
    dish = active_record(session, Dish, payload.dish_id, "菜品") if payload.dish_id else None
    meal = MealPlan(id=new_id(), **payload.model_dump())
    session.add(meal)
    display_name = dish.name if dish else payload.custom_name
    agenda = AgendaItem(
        title=f"{MEAL_NAMES[payload.meal_type]}：{display_name}",
        plan_date=payload.meal_date,
        module="diet", source_type="meal_plan", source_id=meal.id,
    )
    session.add(agenda); session.flush(); meal.agenda_id = agenda.id
    session.flush()
    return meal_out(session, meal)


@router.patch("/meals/{meal_id}")
def update_meal(meal_id: str, payload: MealIn, session: Session = Depends(get_session)):
    meal = active_record(session, MealPlan, meal_id, "饮食安排")
    if not payload.dish_id and not payload.custom_name.strip():
        raise HTTPException(422, "请选择菜品或填写餐食名称")
    dish = active_record(session, Dish, payload.dish_id, "菜品") if payload.dish_id else None
    apply_changes(meal, payload.model_dump(), set(MealIn.model_fields))
    agenda = session.get(AgendaItem, meal.agenda_id) if meal.agenda_id else None
    if not agenda:
        agenda = AgendaItem(
            plan_date=meal.meal_date,
            module="diet", source_type="meal_plan", source_id=meal.id,
        )
        session.add(agenda); session.flush(); meal.agenda_id = agenda.id
    if agenda:
        agenda.plan_date = meal.meal_date
        agenda.title = f"{MEAL_NAMES[meal.meal_type]}：{dish.name if dish else meal.custom_name}"
    session.flush()
    return meal_out(session, meal)


@router.delete("/meals/{meal_id}")
def delete_meal(meal_id: str, session: Session = Depends(get_session)):
    meal = active_record(session, MealPlan, meal_id, "饮食安排")
    delete_meal_plan(session, meal)
    return meal_out(session, meal)


@router.get("/health/{log_date}")
def get_health(log_date: date, session: Session = Depends(get_session)):
    item = session.scalar(select(DailyHealthLog).where(
        DailyHealthLog.log_date == log_date, DailyHealthLog.deleted_at.is_(None)
    ))
    if not item:
        return {"log_date": log_date, "water_ml": 0, "weight_kg": None, "feeling": ""}
    return model_dict(item)


@router.put("/health/{log_date}")
def put_health(log_date: date, payload: HealthIn, session: Session = Depends(get_session)):
    item = session.scalar(select(DailyHealthLog).where(DailyHealthLog.log_date == log_date))
    if not item:
        item = DailyHealthLog(log_date=log_date, **payload.model_dump()); session.add(item)
    else:
        apply_changes(item, payload.model_dump(), set(HealthIn.model_fields)); item.deleted_at = None
    session.flush()
    return model_dict(item)


@router.post("/shopping-lists/generate", status_code=status.HTTP_201_CREATED)
def generate_shopping_list(payload: ShoppingGenerate, session: Session = Depends(get_session)):
    if payload.end_date < payload.start_date:
        raise HTTPException(422, "结束日期不能早于开始日期")
    meals = session.scalars(select(MealPlan).where(
        MealPlan.meal_date >= payload.start_date, MealPlan.meal_date <= payload.end_date,
        MealPlan.dish_id.is_not(None), MealPlan.deleted_at.is_(None),
    )).all()
    dish_counts: dict[str, int] = defaultdict(int)
    for meal in meals:
        if meal.dish_id:
            dish_counts[meal.dish_id] += 1
    dish_ids = set(dish_counts)
    totals: dict[tuple[str, str], float | None] = defaultdict(float)
    for ingredient in session.scalars(select(DishIngredient).where(DishIngredient.dish_id.in_(dish_ids))).all() if dish_ids else []:
        key = (ingredient.name.strip().lower(), ingredient.unit.strip())
        if ingredient.quantity is None:
            totals[key] = None
        elif totals[key] is not None:
            totals[key] += ingredient.quantity * dish_counts[ingredient.dish_id]
    shopping = ShoppingList(name=payload.name, start_date=payload.start_date, end_date=payload.end_date)
    session.add(shopping); session.flush()
    for (name, unit), quantity in sorted(totals.items()):
        quantity_text = "按需" if quantity is None else f"{quantity:g}{unit}"
        session.add(ShoppingItem(shopping_list_id=shopping.id, ingredient_name=name, quantity_text=quantity_text))
    session.flush()
    return shopping_out(session, shopping)


def shopping_out(session: Session, shopping: ShoppingList) -> dict:
    data = model_dict(shopping)
    data["items"] = [model_dict(item) for item in session.scalars(select(ShoppingItem).where(
        ShoppingItem.shopping_list_id == shopping.id, ShoppingItem.deleted_at.is_(None)
    ).order_by(ShoppingItem.ingredient_name)).all()]
    return data


@router.get("/shopping-lists")
def list_shopping_lists(session: Session = Depends(get_session)):
    return [shopping_out(session, item) for item in session.scalars(select(ShoppingList).where(
        ShoppingList.deleted_at.is_(None)
    ).order_by(ShoppingList.created_at.desc())).all()]


@router.patch("/shopping-items/{item_id}")
def update_shopping_item(item_id: str, payload: ShoppingItemPatch, session: Session = Depends(get_session)):
    item = active_record(session, ShoppingItem, item_id, "购物项目")
    apply_changes(item, payload.model_dump(exclude_unset=True), set(ShoppingItemPatch.model_fields))
    session.flush()
    return model_dict(item)
