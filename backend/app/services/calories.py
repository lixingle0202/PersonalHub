"""Food/recipe-based energy estimates with explicit portion assumptions."""
from collections.abc import Sequence
from dataclasses import dataclass
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Dish, DishIngredient


# Rounded ingredient reference values (kcal/100 g), retained from the USDA-based
# ingredient table. Only whole names/aliases match: egg cake is not an egg.
KCAL_100G = {
    "鸡蛋": 140, "番茄": 18, "西红柿": 18, "米饭": 130, "燕麦": 389,
    "牛奶": 61, "鸡胸肉": 165, "豆腐": 80, "菠菜": 23, "食用油": 884,
    "白糖": 387, "香蕉": 89, "苹果": 52, "面包": 265, "土豆": 77,
    "胡萝卜": 41, "鱼": 120, "虾": 85, "酸奶": 65, "黄瓜": 15,
    "西兰花": 34, "大米": 365, "猪肉": 240, "牛肉": 180,
    "水": 0, "盐": 0,
    # CFS sweet soup study: red bean sweet soup 66 kcal/100 g.
    # https://www.cfs.gov.hk/english/programme/programme_rafs/programme_rafs_n_01_21_abstract.html
    "红豆糖水": 66,
    # MOHW packaged plain rice balls: 258 kcal/100 g (package, before cooking).
    # https://mohw.gov.tw/dl-15745-93035175-b28d-40f9-b5eb-adb7a43c4c99.html
    "无馅小汤圆": 258,
}
ALIASES = {
    "纯牛奶": "牛奶", "鲜牛奶": "牛奶", "水煮蛋": "鸡蛋", "煮鸡蛋": "鸡蛋",
    "白米饭": "米饭", "白饭": "米饭", "食盐": "盐", "清水": "水",
    "植物油": "食用油", "橄榄油": "食用油", "花生油": "食用油",
    "红豆汤": "红豆糖水", "红豆沙": "红豆糖水", "无馅汤圆": "无馅小汤圆",
    "红白小汤圆": "无馅小汤圆", "白砂糖": "白糖",
}
TYPICAL_GRAMS = {"鸡蛋": 50, "番茄": 150, "西红柿": 150, "香蕉": 120,
                 "苹果": 180, "土豆": 150, "胡萝卜": 100, "黄瓜": 180}
# These are assumptions, not measured portions for an individual meal.
DEFAULT_PORTIONS = {"米饭": (200, "克"), "鸡蛋": (1, "个"), "牛奶": (250, "毫升"),
                    "酸奶": (200, "毫升"), "面包": (80, "克"), "燕麦": (40, "克"),
                    "香蕉": (1, "根"), "苹果": (1, "个"), "红豆糖水": (200, "克"),
                    "无馅小汤圆": (50, "克")}
GRAM_UNITS = {"g": 1, "克": 1, "公克": 1, "kg": 1000, "千克": 1000,
              "公斤": 1000, "斤": 500, "两": 50}
NUMBERED_FOOD = re.compile(r"^(.+?)\s*(\d+(?:\.\d+)?)\s*(千克|公斤|公克|毫升|克|斤|两|kg|ml|g|个|只|根|片|份|碗)$", re.I)
RED_BEAN_BALLS = {"红豆小丸子", "红豆小汤圆", "红豆汤圆"}


@dataclass(frozen=True)
class CalorieEstimate:
    kcal: int | None
    source: str
    explanation: str


def normalized_name(name: str) -> str:
    return re.sub(r"\s+", "", name).strip()


def ingredient_energy(name: str, quantity: float | None, unit: str) -> float | None:
    name = normalized_name(name)
    key = ALIASES.get(name, name)
    if key not in KCAL_100G:
        return None
    if KCAL_100G[key] == 0:
        return 0
    if quantity is None:
        return None
    unit = unit.strip().lower()
    if unit in GRAM_UNITS:
        grams = quantity * GRAM_UNITS[unit]
    elif unit in {"ml", "毫升"} and key in {"牛奶", "酸奶", "食用油"}:
        grams = quantity * (0.91 if key == "食用油" else 1)
    elif unit in {"个", "只", "根"} and key in TYPICAL_GRAMS:
        grams = quantity * TYPICAL_GRAMS[key]
    else:
        return None
    return grams * KCAL_100G[key] / 100


def ingredient_kcal(item: DishIngredient) -> float | None:
    return ingredient_energy(item.name, item.quantity, item.unit)


def reference_food(name: str) -> tuple[float, str, str] | None:
    """Match a whole food, optionally with a weight/count, never a substring."""
    name = normalized_name(name)
    match = NUMBERED_FOOD.fullmatch(name)
    quantity, unit = (float(match[2]), match[3].lower()) if match else (None, "")
    name = match[1] if match else name
    if quantity is not None and quantity <= 0:
        return None
    if name in RED_BEAN_BALLS:
        if quantity is not None and unit not in {"份", "碗"}:
            return None
        count = quantity if quantity is not None else 1
        # A disclosed example recipe, not a measured density for every version.
        kcal = (200 * KCAL_100G["红豆糖水"] + 50 * KCAL_100G["无馅小汤圆"]) / 100
        return kcal * count, "参考配方", f"{count:g}份参考配方：每份红豆糖水200克 + 无馅小汤圆50克（包装重量）；糖量、品牌不同可在常用菜品中修改配方"
    key = ALIASES.get(name, name)
    if key not in DEFAULT_PORTIONS:
        return None
    if quantity is None or unit in {"份", "碗"}:
        count = quantity if quantity is not None else 1
        amount, amount_unit = DEFAULT_PORTIONS[key]
        energy = ingredient_energy(key, amount, amount_unit)
        if energy is None:
            return None
        return energy * count, "食物参考", f"{name}按{count:g}份、每份{amount:g}{amount_unit}估算"
    energy = ingredient_energy(key, quantity, unit)
    if energy is None:
        return None
    return energy, "食物参考", f"{name}{quantity:g}{unit}，按每100克参考热量折算"


def estimate_meal(session: Session, dishes: Sequence[Dish], override: int | None = None,
                  *, custom_name: str = "", servings: float = 1) -> CalorieEstimate:
    if override is not None:
        return CalorieEstimate(override, "手动填写", "使用手动填写的这餐总热量，不再乘以份数")
    total = 0.0
    sources: set[str] = set()
    details: list[str] = []
    missing: list[str] = []
    for dish in dishes:
        if dish.estimated_kcal is not None:
            total += dish.estimated_kcal
            sources.add("菜品设置")
            details.append(f"{dish.name}：每份{dish.estimated_kcal} kcal（菜品设置）")
            continue
        items = session.scalars(select(DishIngredient).where(DishIngredient.dish_id == dish.id)).all()
        if items:
            values = [ingredient_kcal(item) for item in items]
            if any(value is None for value in values):
                missing.extend(f"{dish.name}的{item.name}（需补充可识别食材、数量和单位）" for item, value in zip(items, values) if value is None)
                continue
            recipe_total = sum(value for value in values if value is not None)
            total += recipe_total / dish.recipe_servings
            sources.add("食材粗估")
            details.append(f"{dish.name}：配方合计{recipe_total:.0f} kcal ÷ {dish.recipe_servings:g}份")
        else:
            reference = reference_food(dish.name)
            if reference is None:
                missing.append(dish.name)
            else:
                energy, source, description = reference
                total += energy; sources.add(source); details.append(description)
    if not dishes:
        for name in re.split(r"[、+＋,，;；\n]|和", custom_name):
            if not name.strip():
                continue
            reference = reference_food(name)
            if reference is None:
                missing.append(name.strip())
            else:
                energy, source, description = reference
                total += energy; sources.add(source); details.append(description)
    if missing or not sources:
        return CalorieEstimate(None, "待补充", "无法完整估算：" + "、".join(missing or [custom_name]) + "。请在常用菜品中补充食材用量或每份热量，也可直接填写这餐总热量。")
    source = next(iter(sources)) if len(sources) == 1 else "多菜品估算"
    return CalorieEstimate(round(total * servings), source, "；".join(details) + f"；本餐按{servings:g}份计算。相同食物和份量不随餐次改变")
