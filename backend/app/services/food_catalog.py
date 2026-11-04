"""Exact, traceable lookup of the bundled open nutrition dataset."""
from collections import defaultdict
from dataclasses import dataclass
import re

from .food_catalog_data import FOOD_DATA, SOURCE_URL


def food_key(name: str) -> str:
    return re.sub(r'\s+', '', name).replace('（', '(').replace('）', ')').lower()


@dataclass(frozen=True)
class CatalogFood:
    code: str
    name: str
    aliases: tuple[str, ...]
    category: str
    kcal_100g: float
    description: str


FOODS = tuple(CatalogFood(*record) for record in FOOD_DATA)
BY_NAME = {food_key(food.name): food for food in FOODS}
_aliases: dict[str, list[CatalogFood]] = defaultdict(list)
for _food in FOODS:
    for _alias in set(_food.aliases):
        _aliases[food_key(_alias)].append(_food)
# Ambiguous aliases are excluded; a named variant must be selected explicitly.
BY_ALIAS = {alias: entries[0] for alias, entries in _aliases.items()
            if len({food.code for food in entries}) == 1 and alias not in BY_NAME}

# Common mainland names mapped to an explicit sample, never a substring match.
COMMON_NAMES = {
    '香菇': '香菇平均值', '茄子': '长茄子', '白菜': '包心白菜', '大白菜': '包心白菜',
    '洋葱': '黄洋葱', '豆角': '豇豆(荚)', '长豆角': '豇豆(荚)',
    '鸡腿肉': '去皮去骨鸡腿(肉鸡)', '排骨': '猪小排', '猪排骨': '猪小排',
    '花生仁': '去膜花生仁(生)', '白醋': '米醋', '淀粉': '玉米粉',
    '茭白': '茭白笋', '白萝卜': '白萝卜', '虾仁': '须赤虾仁',
    '南瓜': '南瓜平均值', '油菜': '油菜(有机)', '甘蓝': '甘蓝平均值',
    '包菜': '甘蓝平均值', '生菜': '不结球莴苣平均值', '苦瓜': '苦瓜(青皮)',
    '葱': '青葱平均值', '小葱': '青葱平均值',
    '韭菜': '韮菜', '韭黄': '韮黄',
    '鸡翅': '二节翅平均值',
    '土豆': '马铃薯',
}


def lookup_food(name: str) -> CatalogFood | None:
    key = food_key(name)
    target = COMMON_NAMES.get(key)
    return BY_NAME.get(food_key(target or name)) or BY_ALIAS.get(key)


def food_search_rank(query: str, names) -> int | None:
    key = food_key(query)
    if not key:
        return 0
    words = [food_key(word) for word in query.split()]
    best = None
    for name in names:
        candidate = food_key(name)
        rank = (0 if key == candidate else 1 if candidate.startswith(key)
                else 2 if key in candidate else 3 if all(word in candidate for word in words) else None)
        if rank is not None:
            best = rank if best is None else min(best, rank)
    return best


def search_foods(query: str, limit: int = 20) -> list[CatalogFood]:
    found = []
    exact = lookup_food(query)
    for food in FOODS:
        aliases = [alias for alias in food.aliases if BY_ALIAS.get(food_key(alias)) is food]
        rank = 0 if food is exact else food_search_rank(query, (food.name, *aliases))
        if rank is not None:
            found.append((rank, food))
    found.sort(key=lambda match: match[0])
    return [food for _, food in found[:limit]]
