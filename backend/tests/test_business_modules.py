from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    with TestClient(app) as client:
        client.headers["x-local-token"] = app.state.local_token
        yield client
    app.state.database.dispose()


def test_media_pipeline_metrics_and_agenda_sync(client):
    created = client.post("/api/v1/media", json={
        "title": "Python 学习路线", "platform": "公众号",
        "content_type": "文章", "stage": "creating", "target_date": "2026-10-01",
        "outline": "基础、项目、复盘",
    })
    assert created.status_code == 201
    media = created.json()
    agenda = client.get("/api/v1/agenda", params={"date": "2026-10-01"}).json()
    assert len(agenda) == 1 and agenda[0]["source_id"] == media["id"]

    published = client.post(f"/api/v1/media/{media['id']}/transition", json={
        "stage": "published", "published_at": "2026-10-01", "publish_link": "https://example.test/post",
    })
    assert published.json()["stage"] == "published"
    assert client.get("/api/v1/agenda", params={"date": "2026-10-01"}).json()[0]["status"] == "completed"
    metric = client.post(f"/api/v1/media/{media['id']}/metrics", json={
        "recorded_on": "2026-10-02", "views": 100, "likes": 12, "comments": 3, "favorites": 7,
    })
    assert metric.status_code == 201
    assert client.get(f"/api/v1/media/{media['id']}/metrics").json()[0]["favorites"] == 7


def test_development_project_has_all_domain_records(client):
    project = client.post("/api/v1/dev/projects", json={"name": "本地应用", "status": "active"}).json()
    project_id = project["id"]
    endpoints = [
        ("requirements", {"title": "离线运行", "priority": "high"}),
        ("issues", {"title": "启动失败", "is_blocking": True, "severity": "high"}),
        ("milestones", {"name": "完成第一版", "target_date": "2026-10-10"}),
        ("logs", {"log_date": "2026-09-30", "completed_work": "建立数据层"}),
    ]
    for resource, payload in endpoints:
        response = client.post(f"/api/v1/dev/projects/{project_id}/{resource}", json=payload)
        assert response.status_code == 201
        listed = client.get(f"/api/v1/dev/projects/{project_id}/{resource}")
        assert len(listed.json()) == 1
    home = client.get("/api/v1/home", params={"date": "2026-09-30"}).json()
    assert home["summaries"]["development"]["count"] == 1
    assert "完成第一版" in home["summaries"]["development"]["detail"]


def test_consultation_solution_communication_followup_and_copy(client):
    consultation = client.post("/api/v1/consultations", json={
        "title": "Python 学习计划", "client_name": "用户A",
        "original_question": "我想学习 Python", "goal": "能独立完成小项目",
        "overall_advice": "先学基础，再完成项目", "resources": "Python 官方教程",
    }).json()
    consultation_id = consultation["id"]
    assert client.post(f"/api/v1/consultations/{consultation_id}/stages", json={
        "title": "基础阶段", "goal": "掌握语法", "steps": "变量、函数、类", "schedule": "第1-4周",
    }).status_code == 201
    assert client.post(f"/api/v1/consultations/{consultation_id}/communications", json={
        "content": "确认每周可投入 6 小时", "feedback": "可以执行",
    }).status_code == 201
    followup = client.post(f"/api/v1/consultations/{consultation_id}/followups", json={
        "title": "回访第一周进度", "plan_date": "2026-10-07",
    })
    assert followup.status_code == 201
    copied = client.get(f"/api/v1/consultations/{consultation_id}/copy-text").json()["text"]
    assert "基础阶段" in copied and "第1-4周" in copied
    agenda = client.get("/api/v1/agenda", params={"date": "2026-10-07"}).json()
    assert agenda[0]["module"] == "consulting"


def test_learning_route_progress_tasks_sessions_and_resources(client):
    goal = client.post("/api/v1/learning/goals", json={
        "name": "学习 Python", "goal": "完成自动化项目", "estimated_minutes": 2400,
    }).json()
    section = client.post(f"/api/v1/learning/goals/{goal['id']}/sections", json={
        "name": "语法基础", "sort_order": 1,
    }).json()
    client.patch(f"/api/v1/learning/sections/{section['id']}", json={"is_completed": True})
    task = client.post(f"/api/v1/learning/goals/{goal['id']}/tasks", json={
        "title": "练习函数", "section_id": section["id"], "plan_date": "2026-09-30",
    })
    assert task.status_code == 201
    assert client.post(f"/api/v1/learning/goals/{goal['id']}/sessions", json={
        "studied_on": "2026-09-30", "actual_minutes": 60, "notes": "完成函数练习",
    }).status_code == 201
    assert client.post(f"/api/v1/learning/goals/{goal['id']}/resources", json={
        "name": "官方教程", "link": "https://docs.python.org/zh-cn/3/tutorial/",
    }).status_code == 201
    detail = client.get(f"/api/v1/learning/goals/{goal['id']}").json()
    assert detail["progress"] == 100
    assert detail["progress_is_manual"] is False
    assert detail["sessions"][0]["actual_minutes"] == 60
    assert client.get("/api/v1/agenda", params={"date": "2026-09-30"}).json()[0]["module"] == "learning"

    updated = client.patch(f"/api/v1/learning/goals/{goal['id']}", json={
        "name": "Python 实战计划", "goal": "完成两个自动化项目",
        "start_date": "2026-09-01", "target_date": "2026-12-31",
        "estimated_minutes": 3600, "progress": 65,
    })
    assert updated.status_code == 200
    assert updated.json()["name"] == "Python 实战计划"
    assert updated.json()["estimated_minutes"] == 3600
    assert updated.json()["progress"] == 65
    assert updated.json()["progress_is_manual"] is True
    assert client.get("/api/v1/learning/goals").json()[0]["progress"] == 65
    assert client.patch(f"/api/v1/learning/goals/{goal['id']}", json={"progress": 101}).status_code == 422


def test_diet_week_plan_health_and_generated_shopping_list(client):
    dish = client.post("/api/v1/diet/dishes", json={
        "name": "番茄炒蛋",
        "ingredients": [
            {"name": "鸡蛋", "quantity": 2, "unit": "个"},
            {"name": "番茄", "quantity": 2, "unit": "个"},
        ],
    }).json()
    for meal_date in ["2026-09-30", "2026-10-01"]:
        assert client.post("/api/v1/diet/meals", json={
            "meal_date": meal_date, "meal_type": "dinner", "dish_id": dish["id"],
        }).status_code == 201
    health = client.put("/api/v1/diet/health/2026-09-30", json={
        "water_ml": 1800, "weight_kg": 65.5, "feeling": "状态良好",
    })
    assert health.status_code == 200
    shopping = client.post("/api/v1/diet/shopping-lists/generate", json={
        "name": "本周采购", "start_date": "2026-09-30", "end_date": "2026-10-01",
    })
    assert shopping.status_code == 201
    items = {item["ingredient_name"]: item["quantity_text"] for item in shopping.json()["items"]}
    assert items == {"鸡蛋": "4个", "番茄": "4个"}


def test_diet_meal_can_be_edited_and_keeps_the_home_plan_in_sync(client):
    meal = client.post("/api/v1/diet/meals", json={
        "meal_date": "2026-10-05", "meal_type": "lunch", "custom_name": "米饭",
    }).json()

    updated = client.patch(f"/api/v1/diet/meals/{meal['id']}", json={
        "meal_date": "2026-10-05", "meal_type": "lunch", "custom_name": "鸡胸肉沙拉",
    })

    assert updated.status_code == 200
    assert updated.json()["dish_name"] == "鸡胸肉沙拉"
    home = client.get("/api/v1/home", params={"date": "2026-10-05"}).json()
    assert [item["title"] for item in home["agenda"]] == ["午餐：鸡胸肉沙拉"]
    invalid = client.patch(f"/api/v1/diet/meals/{meal['id']}", json={
        "meal_date": "2026-10-05", "meal_type": "lunch", "custom_name": "",
    })
    assert invalid.status_code == 422


def test_diet_reset_cancels_meals_across_all_dates_but_keeps_other_diet_data(client):
    dish = client.post("/api/v1/diet/dishes", json={"name": "番茄炒蛋"}).json()
    for meal_date in ["2026-10-05", "2026-11-20"]:
        assert client.post("/api/v1/diet/meals", json={
            "meal_date": meal_date, "meal_type": "dinner", "dish_id": dish["id"],
        }).status_code == 201
    assert client.put("/api/v1/diet/health/2026-10-05", json={
        "water_ml": 1800, "feeling": "很好",
    }).status_code == 200

    reset = client.post("/api/v1/diet/reset")

    assert reset.status_code == 200
    assert reset.json() == {"cancelled_meals": 2, "cancelled_agenda": 2}
    assert client.get("/api/v1/diet/meals", params={
        "start_date": "2026-01-01", "end_date": "2026-12-31",
    }).json() == []
    assert client.get("/api/v1/agenda", params={"date": "2026-10-05"}).json() == []
    assert client.get("/api/v1/agenda", params={"date": "2026-11-20"}).json() == []
    assert [item["name"] for item in client.get("/api/v1/diet/dishes").json()] == ["番茄炒蛋"]
    assert client.get("/api/v1/diet/health/2026-10-05").json()["water_ml"] == 1800
    assert client.post("/api/v1/diet/reset").json() == {"cancelled_meals": 0, "cancelled_agenda": 0}


def test_retired_games_api_is_not_available(client):
    assert client.get("/api/v1/games").status_code == 404
    assert client.post("/api/v1/games", json={"name": "示例游戏"}).status_code == 404
    assert not any(path.startswith("/api/v1/games") for path in client.get("/openapi.json").json()["paths"])
