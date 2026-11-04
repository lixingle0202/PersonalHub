"""Food/recipe-based energy estimates with explicit portion assumptions."""
from collections.abc import Sequence
from dataclasses import dataclass
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Dish, DishIngredient
from .food_reference import EXTRA_ALIASES, EXTRA_KCAL_100G, RECIPE_ALIASES, REFERENCE_RECIPES
from .food_catalog import FOODS, SOURCE_URL, lookup_food, search_foods


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
KCAL_100G.update(EXTRA_KCAL_100G)
ALIASES = {
    "纯牛奶": "牛奶", "鲜牛奶": "牛奶", "水煮蛋": "鸡蛋", "煮鸡蛋": "鸡蛋",
    "白米饭": "米饭", "白饭": "米饭", "食盐": "盐", "清水": "水",
    "植物油": "食用油", "橄榄油": "食用油", "花生油": "食用油",
    "红豆汤": "红豆糖水", "红豆沙": "红豆糖水", "无馅汤圆": "无馅小汤圆",
    "红白小汤圆": "无馅小汤圆", "白砂糖": "白糖",
}
ALIASES.update(EXTRA_ALIASES)
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
class FoodEstimate:
    name: str
    kcal: float | None
    source: str
    explanation: str


@dataclass(frozen=True)
class CalorieEstimate:
    kcal: int | None
    source: str
    explanation: str
    items: tuple[FoodEstimate, ...] = ()

    def item_details(self) -> list[dict]:
        return [dict(name=item.name, kcal=round(item.kcal, 1) if item.kcal is not None else None,
                     source=item.source, explanation=item.explanation) for item in self.items]

    @property
    def known_kcal(self) -> int:
        return round(sum(item.kcal for item in self.items if item.kcal is not None))


def normalized_name(name: str) -> str:
    return re.sub(r"\s+", "", name).strip()


def ingredient_name(name: str) -> str:
    name = re.sub(r'[（(](?:切片|切丝|切块|切末|去皮|洗净|生重)[)）]$', '', normalized_name(name))
    return ALIASES.get(name, name)


def ingredient_grams(name: str, quantity: float | None, unit: str) -> float | None:
    key = ingredient_name(name)
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
    return grams


def ingredient_energy(name: str, quantity: float | None, unit: str) -> float | None:
    key = ingredient_name(name)
    catalog = lookup_food(key) if key not in KCAL_100G else None
    density = KCAL_100G.get(key, catalog.kcal_100g if catalog else None)
    if density is None:
        return None
    if density == 0:
        return 0
    grams = ingredient_grams(name, quantity, unit)
    if grams is None:
        return None
    return grams * density / 100


def ingredient_kcal(item: DishIngredient) -> float | None:
    return ingredient_energy(item.name, item.quantity, item.unit)


def recipe_for(name: str):
    name = normalized_name(name)
    return REFERENCE_RECIPES.get(RECIPE_ALIASES.get(name, name))


def recipe_reference(name: str, count: float = 1, *, grams: float | None = None) -> tuple[float, str, str] | None:
    recipe = recipe_for(name)
    if not recipe:
        return None
    values = [(food, quantity, unit, ingredient_energy(food, quantity, unit)) for food, quantity, unit in recipe]
    if any(energy is None for _, _, _, energy in values):
        return None
    total = sum(energy for _, _, _, energy in values if energy is not None)
    lines = ' + '.join(f'{food}{quantity:g}{unit}≈{energy:.0f} kcal' for food, quantity, unit, energy in values)
    weight_note = ''
    if grams is not None:
        weights = [ingredient_grams(food, quantity, unit) for food, quantity, unit in recipe]
        if any(weight is None for weight in weights):
            return None
        reference_weight = sum(weight for weight in weights if weight is not None)
        count = grams / reference_weight
        weight_note = (f'按食用{grams:g}克换算；参考食材合计约{reference_weight:g}克，'
                       '以此近似成品重量，烹饪水分变化会影响结果；')
    return total * count, '参考配方', (
        weight_note + f'{name}按{count:.3g}份参考配方：每份{lines}；每份合计约{total:.0f} kcal。'
        '这是示例用量，食材按烹饪前可食重量计算，油按全部食用估算；不代表餐馆实测值，可修改常用菜品配方'
    )


def reference_food(name: str) -> tuple[float, str, str] | None:
    """Match a whole food, optionally with a weight/count, never a substring."""
    name = normalized_name(name)
    match = NUMBERED_FOOD.fullmatch(name)
    quantity, unit = (float(match[2]), match[3].lower()) if match else (None, "")
    name = match[1] if match else name
    if quantity is not None and quantity <= 0:
        return None
    if recipe_for(name):
        if quantity is not None and unit in GRAM_UNITS:
            return recipe_reference(name, grams=quantity * GRAM_UNITS[unit])
        if quantity is not None and unit not in {'份', '碗'}:
            return None
        return recipe_reference(name, quantity if quantity is not None else 1)
    if name in RED_BEAN_BALLS:
        if quantity is not None and unit not in {"份", "碗"}:
            return None
        count = quantity if quantity is not None else 1
        # A disclosed example recipe, not a measured density for every version.
        kcal = (200 * KCAL_100G["红豆糖水"] + 50 * KCAL_100G["无馅小汤圆"]) / 100
        return kcal * count, "参考配方", f"{count:g}份参考配方：每份红豆糖水200克 + 无馅小汤圆50克（包装重量）；糖量、品牌不同可在常用菜品中修改配方"
    key = ALIASES.get(name, name)
    if key not in DEFAULT_PORTIONS:
        if key in KCAL_100G:
            if quantity is None or unit in {'份', '碗'}:
                count = quantity if quantity is not None else 1
                energy = KCAL_100G[key] * count
                description = f'{name}未填写克数，暂按每份100克、共{100 * count:g}克估算；请按实际食用量修改'
            else:
                energy = ingredient_energy(key, quantity, unit)
                if energy is None:
                    return None
                description = f'{name}{quantity:g}{unit}'
            return energy, '食物参考', description + f'，按每100克{KCAL_100G[key]:g} kcal折算'
        food = lookup_food(key) or lookup_food(name)
        if not food:
            return None
        if quantity is None or unit in {'份', '碗'}:
            count = quantity if quantity is not None else 1
            grams = count * 100
            amount_note = f'未填写克数，暂按每份100克、共{grams:g}克估算；请按实际食用量修改'
        elif unit in GRAM_UNITS:
            grams = quantity * GRAM_UNITS[unit]
            amount_note = f'食用{grams:g}克'
        else:
            return None
        return grams * food.kcal_100g / 100, '食物数据库', (
            f'{food.name}：每100克{food.kcal_100g:g} kcal，{amount_note}。'
            f'食品药物管理署食品营养成分资料集，编号{food.code}；样品说明：{food.description}。'
            '重量指可食部分，生熟、冷冻等状态应与所选样品一致；不同做法可能有差异'
        )
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


def food_suggestions(query: str, limit: int = 20) -> dict:
    names = dict.fromkeys([*REFERENCE_RECIPES, *RECIPE_ALIASES, *DEFAULT_PORTIONS])
    matches = [name for name in names if not query or normalized_name(query) in name]
    results = []
    for name in matches[:limit]:
        energy, source, _ = reference_food(name)
        results.append({'name': name, 'source': source, 'label': f'{name} · 1份参考约{energy:.0f} kcal'})
    for food in search_foods(query, limit):
        if len(results) >= limit:
            break
        if food.name not in names and ingredient_name(food.name) not in DEFAULT_PORTIONS and not recipe_for(food.name):
            density = KCAL_100G.get(ingredient_name(food.name), food.kcal_100g)
            results.append({'name': food.name, 'source': '食物参考' if ingredient_name(food.name) in KCAL_100G else '食物数据库',
                            'label': f'{food.name} · {density:g} kcal/100克'})
    return {'items': results, 'food_count': len(FOODS), 'recipe_count': len(REFERENCE_RECIPES), 'source_url': SOURCE_URL}


def split_meal_foods(text: str) -> list[str]:
    """Split explicit separators and spaces between whole recognized foods.

    Keep spaces inside a food/quantity (米饭 200 g) together, and never infer
    foods from substrings of an unknown name (鸡蛋糕 is not 鸡蛋).
    """
    if reference_food(text) is not None:
        return [normalized_name(text)]
    # Process separate rows/plus signs before commas: a catalog name itself
    # may contain a comma (for example 冷冻,水晶饺).
    outer, fragment, nesting = [], [], 0
    for character in text:
        if character in '(（':
            nesting += 1
        elif character in ')）':
            nesting = max(0, nesting - 1)
        if not nesting and character in '+＋;；\n':
            outer.append(''.join(fragment)); fragment = []
        else:
            fragment.append(character)
    outer.append(''.join(fragment))
    if len(outer) > 1:
        return [food for part in outer for food in split_meal_foods(part)]
    parts, current, depth = [], [], 0
    for character in text:
        if character in '(（':
            depth += 1
        elif character in ')）':
            depth = max(0, depth - 1)
        if not depth and character in '、+＋,，;；\n和':
            parts.append(''.join(current)); current = []
        else:
            current.append(character)
    parts.append(''.join(current))
    foods: list[str] = []
    for part in parts:
        words = part.split()
        pending: list[str] = []
        index = 0
        while index < len(words):
            # A food name and its number/unit occupy at most a few tokens.
            end = next((end for end in range(min(len(words), index + 8), index, -1)
                        if reference_food(''.join(words[index:end])) is not None), None)
            if end is None:
                pending.append(words[index]); index += 1
                continue
            if pending:
                foods.append(' '.join(pending)); pending = []
            foods.append(''.join(words[index:end])); index = end
        if pending:
            foods.append(' '.join(pending))
    return foods


def estimate_meal(session: Session, dishes: Sequence[Dish], override: int | None = None,
                  *, custom_name: str = "", servings: float = 1) -> CalorieEstimate:
    if override is not None:
        return CalorieEstimate(override, "手动填写", "使用手动填写的这餐总热量，不再乘以份数")
    total = 0.0
    sources: set[str] = set()
    details: list[str] = []
    missing: list[str] = []
    food_details: list[FoodEstimate] = []
    for dish in dishes:
        before_total, before_details = total, len(details)
        if dish.estimated_kcal is not None:
            total += dish.estimated_kcal
            sources.add("菜品设置")
            details.append(f"{dish.name}：每份{dish.estimated_kcal} kcal（菜品设置）")
            food_details.append(FoodEstimate(dish.name, dish.estimated_kcal * servings, '菜品设置', details[-1]))
            continue
        items = session.scalars(select(DishIngredient).where(DishIngredient.dish_id == dish.id)).all()
        if items:
            defaults = {ingredient_name(food): (amount * dish.recipe_servings, unit)
                        for food, amount, unit in (recipe_for(dish.name) or [])}
            values = []
            item_details = []
            assumed = False
            for item in items:
                quantity, unit = item.quantity, item.unit
                default = defaults.get(ingredient_name(item.name))
                used_default = quantity is None and default is not None
                if used_default:
                    quantity, unit = default
                    assumed = True
                energy = ingredient_energy(item.name, quantity, unit)
                values.append(energy)
                if energy is not None:
                    amount = f'{quantity:g}{unit}' if quantity is not None else unit
                    item_details.append(f'{item.name}{amount}≈{energy:.0f} kcal' + ('（参考用量）' if used_default else ''))
            if any(value is None for value in values):
                unavailable = [f"{dish.name}的{item.name}（需补充可识别食材、数量和单位）" for item, value in zip(items, values) if value is None]
                missing.extend(unavailable)
                # Do not count a fraction of an incomplete dish as a whole dish.
                food_details.append(FoodEstimate(dish.name, None, '待补充', '、'.join(unavailable)))
                continue
            recipe_total = sum(value for value in values if value is not None)
            total += recipe_total / dish.recipe_servings
            dish_source = '参考配方' if assumed else '食材粗估'
            sources.add(dish_source)
            details.append(f"{dish.name}：" + ' + '.join(item_details)
                           + f"；配方合计{recipe_total:.0f} kcal ÷ {dish.recipe_servings:g}份")
            if assumed:
                details.append('缺少数量的食材暂按参考用量计算，请按实际食用量修改')
            if not any(ingredient_name(item.name) == '食用油' for item in items):
                details.append('当前配方未填写食用油，额外用油未计入；炒菜请补充实际油量')
        else:
            reference = reference_food(dish.name)
            if reference is None:
                missing.append(dish.name)
                food_details.append(FoodEstimate(dish.name, None, '待补充', '需补充配方用量或每份热量'))
                continue
            else:
                energy, source, description = reference
                dish_source = source
                total += energy; sources.add(source); details.append(description)
        food_details.append(FoodEstimate(dish.name, (total - before_total) * servings,
                                         dish_source,
                                         '；'.join(details[before_details:])))
    for name in split_meal_foods(custom_name):
        reference = reference_food(name)
        if reference is None:
            missing.append(name)
            food_details.append(FoodEstimate(name, None, '待补充', '需补充配方用量或每份热量'))
        else:
            energy, source, description = reference
            total += energy; sources.add(source); details.append(description)
            food_details.append(FoodEstimate(name, energy * servings, source, description))
    if missing or not sources:
        return CalorieEstimate(None, "待补充", "无法完整估算：" + "、".join(missing or [custom_name]) + "。请在常用菜品中补充食材用量或每份热量，也可直接填写这餐总热量。", tuple(food_details))
    source = next(iter(sources)) if len(sources) == 1 else "多菜品估算"
    return CalorieEstimate(round(total * servings), source, "；".join(details) + f"；本餐按{servings:g}份计算。相同食物和份量不随餐次改变", tuple(food_details))
