from datetime import date
from pathlib import Path
import sqlite3

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def local_app(tmp_path):
    settings = Settings(data_root=tmp_path)
    app = create_app(settings)
    with TestClient(app) as client:
        client.headers["x-local-token"] = app.state.local_token
        yield client, app, settings
    app.state.database.dispose()


def test_backup_is_a_valid_independent_database_and_is_listed(local_app):
    client, _app, settings = local_app
    created = client.post("/api/v1/quick-notes", json={"content": "要被备份的内容"})
    assert created.status_code == 201

    response = client.post("/api/v1/backups")
    assert response.status_code == 201
    backup = response.json()
    backup_path = settings.backup_path / backup["name"]
    assert backup_path.is_file()
    assert backup["kind"] == "manual"
    assert len(backup["sha256"]) == 64
    with sqlite3.connect(backup_path) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert connection.execute("SELECT content FROM quick_notes").fetchone()[0] == "要被备份的内容"

    listed = client.get("/api/v1/backups").json()
    assert listed[0]["name"] == backup["name"]


def test_restore_reverts_data_and_always_keeps_a_pre_restore_copy(local_app):
    client, _app, _settings = local_app
    client.patch("/api/v1/settings", json={"nickname": "备份时"})
    backup = client.post("/api/v1/backups").json()
    client.patch("/api/v1/settings", json={"nickname": "恢复前"})

    restored = client.post(f"/api/v1/backups/{backup['name']}/restore")
    assert restored.status_code == 200
    assert restored.json()["pre_restore_backup"]["kind"] == "pre_restore"
    assert client.get("/api/v1/settings").json()["nickname"] == "备份时"

    backups = client.get("/api/v1/backups").json()
    pre_restore = next(item for item in backups if item["kind"] == "pre_restore")
    second_restore = client.post(f"/api/v1/backups/{pre_restore['name']}/restore")
    assert second_restore.status_code == 200
    assert client.get("/api/v1/settings").json()["nickname"] == "恢复前"


def test_corrupt_restore_is_rejected_without_touching_current_data(local_app):
    client, _app, settings = local_app
    note = client.post("/api/v1/quick-notes", json={"content": "当前数据"}).json()
    corrupt = settings.backup_path / "corrupt.db"
    corrupt.write_bytes(b"not a sqlite database")

    response = client.post("/api/v1/backups/corrupt.db/restore")
    assert response.status_code == 400
    assert any(item["id"] == note["id"] for item in client.get("/api/v1/quick-notes").json())
    assert not any(item["kind"] == "pre_restore" for item in client.get("/api/v1/backups").json())


def test_trash_can_restore_then_permanently_delete_an_item(local_app):
    client, _app, _settings = local_app
    item = client.post("/api/v1/agenda", json={"title": "可恢复事项", "plan_date": str(date.today())}).json()
    assert client.delete(f"/api/v1/agenda/{item['id']}").status_code == 200

    trash = client.get("/api/v1/trash").json()
    assert [(entry["type"], entry["title"]) for entry in trash] == [("agenda", "可恢复事项")]
    assert client.post(f"/api/v1/trash/agenda/{item['id']}/restore").status_code == 200
    assert client.get(f"/api/v1/agenda/{item['id']}").status_code == 200

    client.delete(f"/api/v1/agenda/{item['id']}")
    assert client.delete(f"/api/v1/trash/agenda/{item['id']}").status_code == 204
    assert client.get(f"/api/v1/agenda/{item['id']}").status_code == 404
    assert client.get("/api/v1/trash").json() == []


def test_restoring_a_linked_task_also_restores_its_today_plan_without_duplicates(local_app):
    client, _app, _settings = local_app
    project = client.post("/api/v1/dev/projects", json={"name": "测试项目"}).json()
    task = client.post(f"/api/v1/dev/projects/{project['id']}/tasks", json={
        "title": "联动任务", "plan_date": str(date.today()),
    }).json()
    client.delete(f"/api/v1/dev/tasks/{task['id']}")

    trash = client.get("/api/v1/trash").json()
    assert [entry["type"] for entry in trash] == ["dev_task"]
    assert client.get("/api/v1/agenda", params={"date": str(date.today())}).json() == []

    restored = client.post(f"/api/v1/trash/dev_task/{task['id']}/restore")
    assert restored.status_code == 200
    agenda = client.get("/api/v1/agenda", params={"date": str(date.today())}).json()
    assert len(agenda) == 1
    assert agenda[0]["source_id"] == task["id"]
