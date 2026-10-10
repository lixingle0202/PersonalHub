"""Approximate per-serving food energy, never a clinical nutrition calculation."""
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Dish, DishIngredient

# Rounded kcal/100 g reference values for familiar ingredients. Unknown ingredients
# use a clearly labelled meal-type fallback instead of a misleading partial sum.
KCAL_100G = {
    "鸡蛋": 140, "番茄": 18, "西红柿": 18, "米饭": 130, "燕麦": 389,
    "牛奶": 61, "鸡胸肉": 165, "豆腐": 80, "菠菜": 23, "食用油": 884,
    "白糖": 387, "香蕉": 89, "苹果": 52, "面包": 265, "土豆": 77,
    "胡萝卜": 41, "鱼": 120, "虾": 85, "酸奶": 65, "黄瓜": 15,
    "西兰花": 34, "大米": 365, "猪肉": 240, "牛肉": 180,
}
TYPICAL_GRAMS = {"鸡蛋": 50, "番茄": 150, "西红柿": 150, "香蕉": 120,
                 "苹果": 180, "土豆": 150, "胡萝卜": 100, "黄瓜": 180}
MEAL_FALLBACK = {"breakfast": 400, "lunch": 650, "dinner": 600, "snack": 200}


def ingredient_kcal(item: DishIngredient) -> float | None:
    name = item.name.strip()
    key = next((food for food in KCAL_100G if food in name), None)
    if key is None or item.quantity is None:
        return None
    unit = item.unit.strip().lower()
    if unit in {"g", "克"}:
        grams = item.quantity
    elif unit in {"kg", "千克"}:
        grams = item.quantity * 1000
    elif unit in {"ml", "毫升"} and key in {"牛奶", "酸奶"}:
        grams = item.quantity
    elif unit in {"个", "只", "根"} and key in TYPICAL_GRAMS:
        grams = item.quantity * TYPICAL_GRAMS[key]
    else:
        return None
    return grams * KCAL_100G[key] / 100


def estimate_meal(session: Session, meal_type: str, dishes: Sequence[Dish],
                  override: int | None = None) -> tuple[int, str]:
    if override is not None:
        return override, "手动填写"
    totals: list[int] = []
    sources: set[str] = set()
    for dish in dishes:
        if dish.estimated_kcal is not None:
            totals.append(dish.estimated_kcal)
            sources.add("菜品设置")
            continue
        items = session.scalars(select(DishIngredient).where(DishIngredient.dish_id == dish.id)).all()
        values = [ingredient_kcal(item) for item in items]
        if not values or any(value is None for value in values):
            return MEAL_FALLBACK[meal_type], "餐次粗估"
        totals.append(round(sum(values)))
        sources.add("食材粗估")
    if totals:
        return sum(totals), sources.pop() if len(sources) == 1 else "菜品与食材粗估"
    return MEAL_FALLBACK[meal_type], "餐次粗估"
