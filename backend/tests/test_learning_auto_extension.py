from datetime import date, datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.api import learning_extension
from app.config import Settings
from app.main import create_app
from app.models import LearningGoal
from app.public import create_public_app


@pytest.fixture
def project(tmp_path, monkeypatch):
    clock = {"today": date(2026, 10, 3)}
    monkeypatch.setattr(learning_extension, "current_day", lambda: clock["today"])
    app = create_app(Settings(data_root=tmp_path / "private"))
    with TestClient(app) as client:
        client.headers["x-local-token"] = app.state.local_token
        yield client, app, clock
    app.state.database.dispose()


def make_plan(client, app, name="英语六级"):
    goal = client.post("/api/v1/learning/goals", json={
        "name": name, "start_date": "2026-10-01", "target_date": "2026-10-04",
    }).json()
    with app.state.database.session() as session:
        session.get(LearningGoal, goal["id"]).created_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
    tasks = [client.post(f"/api/v1/learning/goals/{goal['id']}/tasks", json={
        "title": f"第 {day} 天任务", "plan_date": f"2026-10-0{day}",
    }).json() for day in range(1, 5)]
    return goal, tasks


def check(client):
    response = client.post("/api/v1/learning/overdue/check")
    assert response.status_code == 200, response.text
    return response.json()


def dates(client, goal_id):
    detail = client.get(f"/api/v1/learning/goals/{goal_id}").json()
    return detail, [task["plan_date"] for task in detail["tasks"]]


def test_fourth_day_reminds_and_shifts_all_pending_tasks_once(project):
    client, app, clock = project
    goal, _tasks = make_plan(client, app)

    assert check(client) == {"shifted_goal_ids": [], "notices": []}
    assert dates(client, goal["id"])[1] == ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]

    clock["today"] = date(2026, 10, 4)
    result = check(client)
    assert result["shifted_goal_ids"] == [goal["id"]]
    assert len(result["notices"]) == 1
    notice = result["notices"][0]
    assert notice["goal_name"] == "英语六级"
    assert notice["shifted_days"] == 3
    assert notice["previous_first_date"] == "2026-10-01"
    assert notice["new_first_date"] == "2026-10-04"
    detail, shifted_dates = dates(client, goal["id"])
    assert shifted_dates == ["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"]
    assert (detail["start_date"], detail["target_date"]) == ("2026-10-04", "2026-10-07")
    assert client.get("/api/v1/agenda", params={"date": "2026-10-01"}).json() == []
    assert len(client.get("/api/v1/agenda", params={"date": "2026-10-04"}).json()) == 1
    assert client.get("/api/v1/home", params={"date": "2026-10-04"}).json()["stats"]["total"] == 1

    repeated = check(client)
    assert repeated["shifted_goal_ids"] == []
    assert repeated["notices"] == [notice]
    assert dates(client, goal["id"])[1] == shifted_dates
    assert client.post(f"/api/v1/learning/overdue/reminders/{notice['id']}/ack").json() == {"acknowledged": True}
    assert check(client)["notices"] == []


def test_recent_completion_resets_streak_and_completed_task_keeps_its_date(project):
    client, app, clock = project
    goal, tasks = make_plan(client, app)
    client.post(f"/api/v1/agenda/{tasks[1]['agenda_id']}/complete")
    with app.state.database.session() as session:
        from app.models import AgendaItem
        session.get(AgendaItem, tasks[1]["agenda_id"]).completed_at = datetime(2026, 10, 2, 10, tzinfo=timezone.utc)

    clock["today"] = date(2026, 10, 4)
    assert check(client)["shifted_goal_ids"] == []
    clock["today"] = date(2026, 10, 6)
    result = check(client)
    assert result["shifted_goal_ids"] == [goal["id"]]
    detail, plan_dates = dates(client, goal["id"])
    assert plan_dates == ["2026-10-06", "2026-10-02", "2026-10-08", "2026-10-09"]
    assert detail["start_date"] == "2026-10-01"
    assert detail["target_date"] == "2026-10-09"
    assert detail["tasks"][1]["status"] == "completed"


def test_only_active_due_learning_tasks_trigger_a_reminder(project):
    client, app, clock = project
    goal, tasks = make_plan(client, app)
    client.post(f"/api/v1/agenda/{tasks[0]['agenda_id']}/cancel")
    for task in tasks[1:]:
        client.delete(f"/api/v1/learning/tasks/{task['id']}")
    clock["today"] = date(2026, 10, 7)
    assert check(client) == {"shifted_goal_ids": [], "notices": []}
    assert dates(client, goal["id"])[1] == ["2026-10-01"]


def test_newly_created_backdated_plan_does_not_shift_immediately(project):
    client, app, clock = project
    goal, _tasks = make_plan(client, app)
    with app.state.database.session() as session:
        session.get(LearningGoal, goal["id"]).created_at = datetime(2026, 10, 4, tzinfo=timezone.utc)
    clock["today"] = date(2026, 10, 4)
    assert check(client)["shifted_goal_ids"] == []


def test_manually_completed_goal_is_not_extended(project):
    client, app, clock = project
    goal, _tasks = make_plan(client, app)
    client.patch(f"/api/v1/learning/goals/{goal['id']}", json={"progress": 100})
    clock["today"] = date(2026, 10, 4)
    assert check(client) == {"shifted_goal_ids": [], "notices": []}
    assert dates(client, goal["id"])[1][0] == "2026-10-01"


def test_public_accounts_receive_only_their_own_learning_reminder(tmp_path, monkeypatch):
    monkeypatch.setattr(learning_extension, "current_day", lambda: date(2026, 10, 4))
    public = create_public_app(tmp_path / "shared", secure_cookie=False)
    with TestClient(public, base_url="http://hub.example.test") as alice, TestClient(public, base_url="http://hub.example.test") as bob:
        tokens = []
        for client, name in ((alice, "alice"), (bob, "bobby")):
            assert client.post("/api/v1/public/register", json={
                "username": name, "password": "long-private-password",
            }).status_code == 200
            tokens.append(client.get("/api/v1/bootstrap").json()["local_token"])
        alice.headers["x-local-token"] = tokens[0]
        bob.headers["x-local-token"] = tokens[1]
        first = alice.post("/api/v1/learning/goals", json={"name": "Alice 学习"}).json()
        alice.post(f"/api/v1/learning/goals/{first['id']}/tasks", json={
            "title": "待完成", "plan_date": "2026-10-01",
        })
        alice_app = next(app for app in public.user_apps.values() if app.state.local_token == tokens[0])
        with alice_app.state.database.session() as session:
            session.get(LearningGoal, first["id"]).created_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
        assert len(check(alice)["notices"]) == 1
        assert check(bob) == {"shifted_goal_ids": [], "notices": []}
