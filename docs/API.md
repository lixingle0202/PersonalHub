# PersonalHub 本地接口契约

## 1. 通用约定

- 前缀：`/api/v1`
- 格式：JSON
- 写请求必须携带本次启动产生的本地访问令牌。
- 成功返回对应资源；创建使用 201；删除到回收站使用 200。
- 校验错误返回 422；不存在返回 404；冲突返回 409；内部错误返回 500。
- 列表默认排除归档和回收站内容。

## 2. 系统接口

- `GET /health`
- `GET /api/v1/bootstrap`
- `POST /api/v1/local-session/verify`
- `GET /api/v1/home`
- `GET /api/v1/search?q=`
- `GET /api/v1/search/assist?q=&today=&offset_minutes=`：自然语言条件查询与计划实际对照，返回识别条件、结果、统计及来源。支持修改日期、类别、状态和关键词；统计区分未记录与零，手动学习记录不与专注计时相加。完整参数与口径见[自然语言搜索说明](natural-language-search.md)。
- `GET /api/v1/settings`
- `PATCH /api/v1/settings`

## 3. 今日计划和备忘

- `GET /api/v1/agenda?date=`
- `POST /api/v1/agenda`
- `GET /api/v1/agenda/{id}`
- `PATCH /api/v1/agenda/{id}`
- `POST /api/v1/agenda/{id}/complete`
- `POST /api/v1/agenda/{id}/cancel`
- `POST /api/v1/agenda/{id}/reschedule`
- `POST /api/v1/agenda/reorder`
- `POST /api/v1/agenda/end-day`
- `GET /api/v1/daily-reviews/{date}`
- `PUT /api/v1/daily-reviews/{date}`
- `GET /api/v1/quick-notes`
- `POST /api/v1/quick-notes`
- `PATCH /api/v1/quick-notes/{id}`
- `POST /api/v1/quick-notes/{id}/convert`
- `DELETE /api/v1/quick-notes/{id}`

## 4. 自媒体

- `GET|POST /api/v1/media`
- `GET|PATCH|DELETE /api/v1/media/{id}`
- `POST /api/v1/media/{id}/transition`
- `GET|POST /api/v1/media/{id}/metrics`

## 5. 开发工作

- `GET|POST /api/v1/dev/projects`
- `GET|PATCH|DELETE /api/v1/dev/projects/{id}`
- `GET|POST /api/v1/dev/projects/{id}/requirements`
- `GET|POST /api/v1/dev/projects/{id}/tasks`
- `GET|POST /api/v1/dev/projects/{id}/issues`
- `GET|POST /api/v1/dev/projects/{id}/milestones`
- `GET|POST /api/v1/dev/projects/{id}/logs`
- `PATCH|DELETE /api/v1/dev/{resource}/{id}`

## 6. 咨询工作

- `GET|POST /api/v1/consultations`
- `GET|PATCH|DELETE /api/v1/consultations/{id}`
- `GET|POST /api/v1/consultations/{id}/stages`
- `GET|POST /api/v1/consultations/{id}/communications`
- `GET|POST /api/v1/consultations/{id}/followups`
- `GET /api/v1/consultations/{id}/copy-text`

## 7. 学习计划

- `GET|POST /api/v1/learning/goals`
- `GET|PATCH|DELETE /api/v1/learning/goals/{id}`
- `GET|POST /api/v1/learning/goals/{id}/sections`
- `GET|POST /api/v1/learning/goals/{id}/tasks`
- `GET|POST /api/v1/learning/goals/{id}/sessions`
- `GET|POST /api/v1/learning/goals/{id}/resources`
- `PATCH|DELETE /api/v1/learning/{resource}/{id}`

更新学习目标时允许按需提交名称、目标、日期、预计分钟和 `progress`；`progress` 必须在 0—100 之间。

## 8. 饮食计划

- `GET|POST /api/v1/diet/dishes`
- `GET|PATCH|DELETE /api/v1/diet/dishes/{id}`
- `GET|POST /api/v1/diet/meals`
- `PATCH|DELETE /api/v1/diet/meals/{id}`
- `GET|PUT /api/v1/diet/health/{date}`
- `POST /api/v1/diet/shopping-lists/generate`
- `GET /api/v1/diet/shopping-lists`
- `PATCH /api/v1/diet/shopping-items/{id}`

修改餐次时，必须至少保留一个常用菜品或非空的自定义饮食内容。`PATCH /diet/meals/{id}` 会同步更新关联的今日计划日期和标题；旧数据缺少关联计划时会自动补建。

`GET /diet/meals` 使用 `start_date` / `end_date` 闭区间；月历查询覆盖周一至周日的完整日期范围，包含月初、月末相邻月份日期，保留同日同餐次的多条安排。

`DELETE /diet/meals/{id}` 同时软删除餐食及所有通过关联 ID 或来源 ID 连接的今日计划，兼容旧数据缺失关联 ID 的情况。删除饮食来源的 `DELETE /agenda/{id}` 同样移除对应餐食；日历、首页、今日计划、搜索、逾期/即将到期统计和新生成购物清单均排除已删除餐食。只有显式从回收站恢复后才重新呈现。

## 9. 数据安全

- `GET /api/v1/backups`
- `POST /api/v1/backups`
- `POST /api/v1/backups/{name}/restore`
- `GET /api/v1/trash`
- `POST /api/v1/trash/{type}/{id}/restore`
- `DELETE /api/v1/trash/{type}/{id}`

恢复接口必须验证文件、先备份当前数据，再执行原子替换。无效备份返回 422，不改变当前数据库。

游戏娱乐接口组已下线，不再注册任何游戏资源、计划、游玩记录或娱乐预算接口；相关旧请求返回 404。

## 10. 可选本地 AI 学习计划

- `GET|PUT /api/v1/ai/ollama/settings`：读取或保存 `base_url` 和 `model`。服务地址只允许本机回环地址，禁止路径、凭据和重定向。
- `POST /api/v1/ai/ollama/models`：传入 `base_url`，查询 Ollama `/api/tags` 返回模型名称。
- `POST /api/v1/ai/learning/generate`：传入 `topic`、`objective`、`current_level`、`preferences`、`start_date`、`days`（1—30）、`daily_minutes`（5—480）。调用 Ollama `/api/chat`，使用 JSON schema 结构化输出；成功返回 `{id, plan, imported_goal_id: null}` 草稿，不创建正式学习目标。
- `GET /api/v1/ai/learning/drafts/{id}`：读取持久化草稿。
- `POST /api/v1/ai/learning/drafts/{id}/import`：提交编辑后的完整 `plan`，原日期范围和每日时间预算必须保留。一次事务创建学习目标、章节、任务及关联今日计划，返回目标详情（201）。同一草稿重试返回同一目标；已删除目标的草稿再次导入返回 409。

草稿字段：`name`、`goal`、`start_date`、`target_date`、`daily_minutes`、`sections`（章节名称数组）、`tasks`（`title`、`plan_date`、`section_index` 从 0 开始、`minutes`、`notes`）。允许删除部分任务，但至少保留一项。导入时校验所有任务日期、章节引用、非空名称、同日重复任务及每日总分钟。

生成时按请求天数构造固定的逐日任务槽位，每天生成一个学习阶段和综合任务，学习活动写在说明中；阶段数量固定为计划天数，日期序号、对应章节索引和可用分钟通过 JSON schema 枚举限制。导入接口仍允许同日多个任务，只要总时间符合预算。

未配置或未安装模型返回 422，连接失败返回 503，超时返回 504，Ollama 服务错误或模型输出不合格返回 502。生成最长等待 300 秒，浏览器允许取消等待。后端生成请求可能继续完成并保存草稿，但不会自动导入正式计划。
