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
