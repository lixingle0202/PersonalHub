# 热量估算如何计算

保存一餐前，编辑窗口会显示总热量、计算来源和逐项食材依据。改变菜品或用餐份数会重新估算，保存后的餐食使用同一套计算逻辑；早餐、午餐、晚餐和加餐不再影响同样食物的热量。

计算优先级如下：

1. 手动填写的整餐热量，直接作为总量。
2. 常用菜品中填写的每份热量，再乘本餐用餐份数。
3. 实际配方：各食材用量乘参考能量，合计后除以配方份数，再乘本餐用餐份数。用油和糖应计入配方。
4. 没有配方时，已支持的常见复合菜采用明确列出用量的示例配方。

参考配方目前包括农家小炒肉、青椒炒肉、平菇炒肉、土豆炖牛肉、番茄炒蛋、清炒土豆丝和清炒西兰花，也识别部分常见别名。比如农家小炒肉的一份示例为五花肉120克、青椒150克、大蒜5克、食用油8克、酱油10克；页面会逐项说明热量。这些用量是项目提供的参考，不能代表某家餐馆或个人实际做法，填写实际配方后会优先按实际用量计算。

对于已支持的参考菜品，如果配方里某项缺少数量且有对应的参考用量，会标注“参考用量”；未知食材不会被忽略后给出整餐总热量，而会提示补充。未填写用油的自定义配方会提示额外用油尚未计入。食材按烹饪前可食重量计算，烹饪失水、弃去的油脂和品牌差异仍会带来误差。

新增食材参考依据包括[香港卫生署的猪肉资料](https://restaurant.eatsmart.gov.hk/eng/content.aspx?content_id=645)、[加拿大卫生部蔬菜资料](https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/nutrient-data/table-4-vegetables-vegetable-products-nutrient-value-some-common-foods-2008.html)、[USDA SR28 食材资料](https://www.ars.usda.gov/ARSUserFiles/80400535/Data/SR/SR28/reports/sr28fg11.pdf)和[NASA 存档中的 USDA 豆制品资料](https://ntrs.nasa.gov/api/citations/19950005719/downloads/19950005719.pdf)。代码中的食材表和示例用量保存在 `backend/app/services/food_reference.py`，可继续扩充。
