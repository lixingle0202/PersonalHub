from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def make_client(tmp_path: Path) -> TestClient:
    return TestClient(create_app(Settings(data_root=tmp_path)))


def test_health_is_local(tmp_path):
    with make_client(tmp_path) as client:
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok", "host": "127.0.0.1"}


def test_bootstrap_creates_separate_data_directories(tmp_path):
    with make_client(tmp_path) as client:
        response = client.get("/api/v1/bootstrap")
        assert response.status_code == 200
        body = response.json()
        assert body["local_token"]
        assert Path(body["database_path"]).parent == tmp_path / "data"
        assert (tmp_path / "backups").is_dir()
        assert (tmp_path / "logs").is_dir()


def test_rejects_untrusted_host(tmp_path):
    with make_client(tmp_path) as client:
        response = client.get("/health", headers={"host": "example.com"})
        assert response.status_code == 400


def test_mutating_api_requires_local_token(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    with TestClient(app) as client:
        rejected = client.post("/api/v1/local-session/verify")
        allowed_through_middleware = client.post(
            "/api/v1/local-session/verify",
            headers={"x-local-token": app.state.local_token},
        )
        assert rejected.status_code == 403
        assert allowed_through_middleware.status_code == 200
        assert allowed_through_middleware.json() == {"valid": True}
