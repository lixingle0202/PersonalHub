from __future__ import annotations

import re

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_data_survives_a_complete_application_restart(tmp_path):
    settings = Settings(data_root=tmp_path)
    first = create_app(settings)
    with TestClient(first) as client:
        client.headers["x-local-token"] = first.state.local_token
        note = client.post("/api/v1/quick-notes", json={"content": "关闭后仍然存在"})
        assert note.status_code == 201
        client.patch("/api/v1/settings", json={"nickname": "本机用户"})
    first.state.database.dispose()

    second = create_app(settings)
    with TestClient(second) as client:
        assert client.get("/api/v1/quick-notes").json()[0]["content"] == "关闭后仍然存在"
        assert client.get("/api/v1/settings").json()["nickname"] == "本机用户"
        assert client.get("/api/v1/bootstrap").json()["database_path"] == str(settings.database_path)
    second.state.database.dispose()


def test_production_frontend_is_served_locally_for_direct_routes(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    with TestClient(app) as client:
        home = client.get("/")
        direct_route = client.get("/development")
        assert home.status_code == direct_route.status_code == 200
        assert "PersonalHub" in home.text
        assert home.text == direct_route.text
        references = re.findall(r'(?:src|href)="([^"]+)"', home.text)
        assert references
        assert all(reference.startswith("/") for reference in references)
        for reference in references:
            assert client.get(reference).status_code == 200
    app.state.database.dispose()


def test_server_rejects_non_local_host_headers_and_exposes_all_primary_read_routes(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    with TestClient(app) as client:
        assert client.get("/health", headers={"host": "example.com"}).status_code == 400
        assert client.get("/health").json() == {"status": "ok", "host": "127.0.0.1"}
        routes = [
            "/api/v1/home?date=2026-09-30", "/api/v1/agenda?date=2026-09-30",
            "/api/v1/media", "/api/v1/dev/projects", "/api/v1/consultations",
            "/api/v1/learning/goals", "/api/v1/diet/dishes", "/api/v1/games",
            "/api/v1/settings", "/api/v1/backups", "/api/v1/trash",
        ]
        for route in routes:
            response = client.get(route)
            assert response.status_code == 200, route
    app.state.database.dispose()
