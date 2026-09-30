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


def test_settings_have_defaults_and_persist_updates(client):
    defaults = client.get("/api/v1/settings").json()
    assert defaults["theme_mode"] == "light"
    assert defaults["week_starts_on"] == 1
    updated = client.patch("/api/v1/settings", json={
        "nickname": "我", "theme_mode": "dark", "theme_color": "#123456",
        "default_study_minutes": 90,
    })
    assert updated.status_code == 200
    assert updated.json()["nickname"] == "我"
    assert client.get("/api/v1/settings").json()["default_study_minutes"] == 90
    assert client.patch("/api/v1/settings", json={"theme_color": "red"}).status_code == 422


def test_search_finds_text_across_distinct_modules(client):
    project = client.post("/api/v1/dev/projects", json={"name": "Python 自动化", "description": "处理本地文件"})
    consultation = client.post("/api/v1/consultations", json={"title": "学习 Python", "original_question": "如何安排学习"})
    dish = client.post("/api/v1/diet/dishes", json={"name": "番茄炒蛋", "instructions": "快速晚餐"})
    assert project.status_code == consultation.status_code == dish.status_code == 201

    results = client.get("/api/v1/search", params={"q": "Python"}).json()
    assert {(item["module"], item["title"]) for item in results} == {
        ("development", "Python 自动化"), ("consulting", "学习 Python"),
    }
    food = client.get("/api/v1/search", params={"q": "晚餐"}).json()
    assert food[0]["module"] == "diet"
    assert food[0]["path"].startswith("/diet")
