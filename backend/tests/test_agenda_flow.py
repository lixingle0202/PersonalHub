from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models import AgendaItem


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    with TestClient(app) as client:
        client.headers["x-local-token"] = app.state.local_token
        yield client
    app.state.database.dispose()


def test_agenda_crud_reorder_end_day_and_review(client):
    target = date(2026, 9, 30)
    first = client.post("/api/v1/agenda", json={
        "title": "必须完成", "plan_date": target.isoformat(), "bucket": "must",
    })
    second = client.post("/api/v1/agenda", json={
        "title": "稍后处理", "plan_date": target.isoformat(), "bucket": "optional",
    })
    assert first.status_code == 201
    assert second.status_code == 201
    first_id = first.json()["id"]
    second_id = second.json()["id"]

    reordered = client.post("/api/v1/agenda/reorder", json={"ordered_ids": [second_id, first_id]})
    assert [item["id"] for item in reordered.json()] == [second_id, first_id]

    completed = client.post(f"/api/v1/agenda/{first_id}/complete")
    assert completed.json()["status"] == "completed"

    ended = client.post("/api/v1/agenda/end-day", json={
        "date": target.isoformat(),
        "summary": "完成了重点工作",
        "actions": [{"item_id": second_id, "action": "tomorrow"}],
    })
    assert ended.status_code == 200
    tomorrow = client.get("/api/v1/agenda", params={"date": (target + timedelta(days=1)).isoformat()})
    assert [item["id"] for item in tomorrow.json()] == [second_id]
    review = client.get(f"/api/v1/daily-reviews/{target.isoformat()}")
    assert review.json()["summary"] == "完成了重点工作"


def test_quick_note_converts_once_to_agenda(client):
    note = client.post("/api/v1/quick-notes", json={"content": "整理 Python 学习资料"})
    note_id = note.json()["id"]
    converted = client.post(f"/api/v1/quick-notes/{note_id}/convert", json={
        "target_type": "agenda", "plan_date": "2026-09-30", "bucket": "scheduled",
    })
    assert converted.status_code == 200
    assert converted.json()["title"] == "整理 Python 学习资料"
    duplicate = client.post(f"/api/v1/quick-notes/{note_id}/convert", json={
        "target_type": "agenda", "plan_date": "2026-09-30",
    })
    assert duplicate.status_code == 409


def test_development_task_and_agenda_stay_in_sync_without_duplicates(client):
    project = client.post("/api/v1/dev/projects", json={
        "name": "PersonalHub", "status": "active",
    }).json()
    task = client.post(f"/api/v1/dev/projects/{project['id']}/tasks", json={
        "title": "实现今日计划", "plan_date": "2026-09-30", "priority": "high",
    }).json()

    agenda = client.get("/api/v1/agenda", params={"date": "2026-09-30"}).json()
    assert len(agenda) == 1
    assert agenda[0]["source_id"] == task["id"]

    completed = client.post(f"/api/v1/agenda/{agenda[0]['id']}/complete")
    assert completed.status_code == 200
    tasks = client.get(f"/api/v1/dev/projects/{project['id']}/tasks").json()
    assert tasks[0]["workflow_status"] == "done"

    changed = client.patch(f"/api/v1/dev/tasks/{task['id']}", json={
        "workflow_status": "doing", "plan_date": "2026-10-01",
    })
    assert changed.status_code == 200
    assert changed.json()["agenda_status"] == "pending"
    assert client.get("/api/v1/agenda", params={"date": "2026-09-30"}).json() == []
    next_day = client.get("/api/v1/agenda", params={"date": "2026-10-01"}).json()
    assert len(next_day) == 1
    assert next_day[0]["source_id"] == task["id"]


def test_home_statistics_use_agenda_source_of_truth(client):
    for title, bucket, complete in [
        ("关键工作", "must", True),
        ("普通工作", "scheduled", False),
    ]:
        item = client.post("/api/v1/agenda", json={
            "title": title, "plan_date": "2026-09-30", "bucket": bucket,
        }).json()
        if complete:
            client.post(f"/api/v1/agenda/{item['id']}/complete")
    client.post("/api/v1/agenda", json={
        "title": "逾期事项", "plan_date": "2026-09-29",
    })
    home = client.get("/api/v1/home", params={"date": "2026-09-30"})
    assert home.status_code == 200
    stats = home.json()["stats"]
    assert stats == {
        "total": 2, "completed": 1, "completion_rate": 50,
        "must": 0, "overdue": 1, "due_soon": 0,
    }
    assert set(home.json()["summaries"]) == {
        "media", "development", "consulting", "learning", "diet",
    }


def test_home_collects_today_plans_from_learning_and_diet(client):
    target_date = "2026-10-05"
    goal = client.post("/api/v1/learning/goals", json={
        "name": "Python 学习", "goal": "完成练习",
    }).json()
    client.post(f"/api/v1/learning/goals/{goal['id']}/tasks", json={
        "title": "练习函数", "plan_date": target_date,
    })
    client.post("/api/v1/diet/meals", json={
        "meal_date": target_date, "meal_type": "lunch", "custom_name": "鸡胸肉沙拉",
    })
    response = client.get("/api/v1/home", params={"date": target_date})

    assert response.status_code == 200
    body = response.json()
    assert {item["module"] for item in body["agenda"]} == {"learning", "diet"}
    assert {item["title"] for item in body["agenda"]} == {
        "练习函数", "午餐：鸡胸肉沙拉",
    }
    assert body["summaries"]["learning"]["count"] == 1
    assert body["summaries"]["diet"]["count"] == 1
    assert "games" not in body["summaries"]


def test_retired_game_agenda_is_hidden_from_today_and_home(client):
    target_date = "2026-10-05"
    with client.app.state.database.session() as session:
        session.add(AgendaItem(
            id="legacy-game-agenda", title="游戏：休闲游戏", plan_date=date(2026, 10, 5),
            module="games", source_type="game_plan", source_id="legacy-game-plan",
        ))
    learning_plan = client.post("/api/v1/agenda", json={
        "title": "练习函数", "plan_date": target_date,
        "module": "learning", "bucket": "scheduled",
    })
    rejected = client.post("/api/v1/agenda", json={
        "title": "新游戏计划", "plan_date": target_date,
        "module": "games", "bucket": "scheduled",
    })
    assert learning_plan.status_code == 201
    assert rejected.status_code == 422

    today = client.get("/api/v1/agenda", params={"date": target_date}).json()
    home = client.get("/api/v1/home", params={"date": target_date}).json()
    search = client.get("/api/v1/search", params={"q": "休闲游戏"}).json()

    assert [item["title"] for item in today] == ["练习函数"]
    assert [item["title"] for item in home["agenda"]] == ["练习函数"]
    assert home["stats"]["total"] == 1
    assert search == []
    assert client.get("/api/v1/agenda/legacy-game-agenda").status_code == 404
    assert client.post("/api/v1/agenda/reorder", json={
        "ordered_ids": [learning_plan.json()["id"], "legacy-game-agenda"],
    }).status_code == 422


def test_home_learning_summary_includes_current_goals_without_daily_tasks(client):
    target_date = "2026-10-05"
    client.post("/api/v1/learning/goals", json={
        "name": "物理", "goal": "完成力学复习",
        "start_date": target_date, "target_date": "2026-10-07",
    })
    client.post("/api/v1/learning/goals", json={
        "name": "安卓", "goal": "完成练习程序",
    })
    client.post("/api/v1/learning/goals", json={
        "name": "未来计划", "start_date": "2026-10-06", "target_date": "2026-10-10",
    })

    response = client.get("/api/v1/home", params={"date": target_date})

    assert response.status_code == 200
    summary = response.json()["summaries"]["learning"]
    assert summary["count"] == 2
    assert "物理" in summary["title"]
    assert "安卓" in summary["title"]
    assert "未来计划" not in summary["title"]
    assert summary["detail"] == "今日暂无学习任务"
