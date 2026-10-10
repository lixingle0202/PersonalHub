from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.api import focus
from app.config import Settings
from app.main import create_app


@pytest.fixture
def clocked_client(tmp_path, monkeypatch):
    clock = {"now": datetime(2026, 10, 9, 14, 0, tzinfo=timezone.utc)}
    monkeypatch.setattr(focus, "utc_now", lambda: clock["now"])
    app = create_app(Settings(data_root=tmp_path / "focus"))
    with TestClient(app) as client:
        client.headers["x-local-token"] = app.state.local_token
        yield client, clock
    app.state.database.dispose()


def test_start_stop_persists_actual_elapsed_time_and_daily_total(clocked_client):
    client, clock = clocked_client
    goal = client.post("/api/v1/learning/goals", json={"name": "Python"}).json()
    task = client.post(f"/api/v1/learning/goals/{goal['id']}/tasks", json={"title": "变量练习"}).json()
    path = "/api/v1/learning/focus"
    assert client.post(path + "/start", json={"goal_id": goal["id"], "task_id": task["id"]}).status_code == 200
    assert client.post(path + "/start", json={"goal_id": goal["id"]}).status_code == 409
    clock["now"] = datetime(2026, 10, 9, 14, 25, tzinfo=timezone.utc)
    live = client.get(path + "/today", params={"offset_minutes": -480}).json()
    assert live["seconds"] == 1500 and live["running"]["task_id"] == task["id"]
    assert client.post(path + "/stop").json()["seconds"] == 1500
    assert client.post(path + "/stop").status_code == 409
    assert client.get(path + "/today", params={"offset_minutes": -480}).json()["seconds"] == 1500


def test_focus_time_is_split_at_local_midnight(clocked_client):
    client, clock = clocked_client
    goal = client.post("/api/v1/learning/goals", json={"name": "英语"}).json()
    path = "/api/v1/learning/focus"
    clock["now"] = datetime(2026, 10, 9, 15, 50, tzinfo=timezone.utc)  # 23:50 in Shanghai
    client.post(path + "/start", json={"goal_id": goal["id"]})
    clock["now"] = datetime(2026, 10, 9, 16, 10, tzinfo=timezone.utc)
    client.post(path + "/stop")
    assert client.get(path + "/today", params={"offset_minutes": -480}).json()["seconds"] == 600
    assert client.get(path + "/today", params={"offset_minutes": 0}).json()["seconds"] == 1200


def test_task_must_belong_to_the_selected_learning_goal(clocked_client):
    client, _ = clocked_client
    first = client.post("/api/v1/learning/goals", json={"name": "甲"}).json()
    second = client.post("/api/v1/learning/goals", json={"name": "乙"}).json()
    task = client.post(f"/api/v1/learning/goals/{first['id']}/tasks", json={"title": "练习"}).json()
    assert client.post("/api/v1/learning/focus/start", json={"goal_id": second["id"], "task_id": task["id"]}).status_code == 422


def test_reset_discards_unfinished_time_and_keeps_completed_daily_time(clocked_client):
    client, clock = clocked_client
    goal = client.post("/api/v1/learning/goals", json={"name": "复习"}).json()
    task = client.post(f"/api/v1/learning/goals/{goal['id']}/tasks", json={"title": "听力"}).json()
    path = "/api/v1/learning/focus"
    assert client.post(path + "/reset").status_code == 409
    client.post(path + "/start", json={"goal_id": goal["id"], "task_id": task["id"]})
    clock["now"] = datetime(2026, 10, 9, 14, 5, tzinfo=timezone.utc)
    client.post(path + "/stop")
    client.post(path + "/start", json={"goal_id": goal["id"], "task_id": task["id"]})
    clock["now"] = datetime(2026, 10, 9, 14, 15, tzinfo=timezone.utc)
    reset = client.post(path + "/reset")
    assert reset.status_code == 200
    current = client.get(path + "/today").json()
    assert current["seconds"] == 300
    assert current["running"]["task_id"] == task["id"]
    assert current["running"]["id"] == reset.json()["id"]
    clock["now"] = datetime(2026, 10, 9, 14, 17, tzinfo=timezone.utc)
    assert client.post(path + "/stop").json()["seconds"] == 120
    assert client.get(path + "/today").json()["seconds"] == 420
