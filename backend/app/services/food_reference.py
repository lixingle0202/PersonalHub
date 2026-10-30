"""Disclosed example recipes, not measured restaurant meals or AI guesses.

Energy references (kcal / 100 g edible ingredient):
- HK Department of Health, pork belly 349 and tenderloin 115:
  https://restaurant.eatsmart.gov.hk/eng/content.aspx?content_id=645
- Health Canada, raw green pepper: 16 kcal / 82 g, rounded to 20 / 100 g:
  https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/nutrient-data/table-4-vegetables-vegetable-products-nutrient-value-some-common-foods-2008.html
- Health Canada / USDA, garlic 149:
  https://food-nutrition.canada.ca/cnf-fce/report-rapport
- USDA SR28, ginger 80, oyster mushrooms 33:
  https://www.ars.usda.gov/ARSUserFiles/80400535/Data/SR/SR28/reports/sr28fg11.pdf
- USDA soy sauce (shoyu), 53, reproduced in the NASA technical archive:
  https://ntrs.nasa.gov/api/citations/19950005719/downloads/19950005719.pdf

Recipe quantities below are project-authored portion assumptions. Cooking loss,
fat rendered/discarded, brand, and actual oil retained may change the result.
"""

EXTRA_KCAL_100G = {
    '五花肉': 349, '猪里脊肉': 115, '青椒': 20, '大蒜': 149,
    '生姜': 80, '平菇': 33, '酱油': 53,
}

EXTRA_ALIASES = {
    '五花猪肉': '五花肉', '猪五花肉': '五花肉', '带皮五花肉': '五花肉',
    '里脊': '猪里脊肉', '里脊肉': '猪里脊肉', '猪里脊': '猪里脊肉',
    '青甜椒': '青椒', '甜椒': '青椒', '青椒丝': '青椒', '青椒块': '青椒',
    '蒜': '大蒜', '蒜瓣': '大蒜', '蒜末': '大蒜', '蒜片': '大蒜',
    '姜': '生姜', '姜片': '生姜', '姜丝': '生姜', '姜末': '生姜',
    '生抽': '酱油', '小麦酱油': '酱油', '蚝菇': '平菇',
    '鸡蛋液': '鸡蛋', '西红柿块': '西红柿', '番茄块': '番茄',
    '猪肉片': '猪肉', '猪肉丝': '猪肉', '牛肉片': '牛肉',
    '马铃薯': '土豆', '土豆块': '土豆', '土豆丝': '土豆',
}

# One example serving, ingredient weights before cooking, including oil.
# Changing a saved dish's measured recipe always takes priority.
REFERENCE_RECIPES = {
    '农家小炒肉': (('五花肉', 120, '克'), ('青椒', 150, '克'), ('大蒜', 5, '克'), ('食用油', 8, '克'), ('酱油', 10, '克')),
    '青椒炒肉': (('猪里脊肉', 120, '克'), ('青椒', 150, '克'), ('大蒜', 5, '克'), ('食用油', 8, '克'), ('酱油', 10, '克')),
    '平菇炒肉': (('平菇', 150, '克'), ('猪肉', 80, '克'), ('食用油', 8, '克'), ('大蒜', 5, '克'), ('酱油', 10, '克')),
    '土豆炖牛肉': (('牛肉', 100, '克'), ('土豆', 150, '克'), ('番茄', 100, '克'), ('食用油', 8, '克'), ('生姜', 5, '克'), ('酱油', 10, '克')),
    '番茄炒蛋': (('鸡蛋', 2, '个'), ('番茄', 300, '克'), ('食用油', 8, '克')),
    '清炒土豆丝': (('土豆', 200, '克'), ('食用油', 8, '克'), ('大蒜', 5, '克')),
    '清炒西兰花': (('西兰花', 200, '克'), ('食用油', 8, '克'), ('大蒜', 5, '克')),
}
RECIPE_ALIASES = {
    '小炒肉': '农家小炒肉', '辣椒炒肉': '农家小炒肉',
    '青椒肉丝': '青椒炒肉', '青椒炒肉丝': '青椒炒肉',
    '平菇炒肉片': '平菇炒肉', '西红柿炒鸡蛋': '番茄炒蛋', '西红柿炒蛋': '番茄炒蛋',
    '番茄炒鸡蛋': '番茄炒蛋', '炒土豆丝': '清炒土豆丝', '蒜蓉西兰花': '清炒西兰花',
}
