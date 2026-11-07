from __future__ import annotations

from threading import RLock

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .config import Settings, load_settings
from .api.router import api_router
from .database import Database
from .migrations import migrate_database
from .runtime_paths import frontend_dist_path
from .security import LocalWriteTokenMiddleware, create_local_token


def create_app(settings: Settings | None = None) -> FastAPI:
    current = settings or load_settings()
    current.ensure_directories()
    migrate_database(current.database_path)
    database = Database(current.database_path)
    token = create_local_token()

    app = FastAPI(title="PersonalHub Local API", version="0.1.1")
    app.state.settings = current
    app.state.database = database
    app.state.local_token = token
    app.state.data_lock = RLock()
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=list(current.allowed_hosts),
    )
    app.add_middleware(LocalWriteTokenMiddleware, token=token)

    if current.dev_origin:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=[current.dev_origin],
            allow_credentials=False,
            allow_methods=["*"],
            allow_headers=["Content-Type", "X-Local-Token"],
        )

    app.include_router(api_router)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "host": current.host}

    @app.get("/api/v1/bootstrap")
    def bootstrap() -> dict[str, str]:
        return {
            "app_name": "PersonalHub",
            "version": app.version,
            "local_token": token,
            "database_path": str(current.database_path),
        }

    @app.post("/api/v1/local-session/verify")
    def verify_local_session() -> dict[str, bool]:
        return {"valid": True}

    @app.api_route(
        "/api/{full_path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
        include_in_schema=False,
    )
    def missing_api(full_path: str):
        raise HTTPException(404, "接口不存在")

    frontend_dist = frontend_dist_path()
    assets = frontend_dist / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def frontend(full_path: str):
        root = frontend_dist.resolve()
        candidate = (root / full_path).resolve()
        if full_path and candidate.is_relative_to(root) and candidate.is_file():
            return FileResponse(candidate)
        index = root / "index.html"
        if index.exists():
            return FileResponse(index)
        return {"message": "Frontend has not been built yet."}

    return app
