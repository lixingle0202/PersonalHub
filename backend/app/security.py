from __future__ import annotations

import secrets
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse


SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


class LocalWriteTokenMiddleware(BaseHTTPMiddleware):
    """Require a per-process token for local mutating API requests."""

    def __init__(self, app, token: str):
        super().__init__(app)
        self.token = token

    async def dispatch(self, request: Request, call_next):
        if (
            request.url.path.startswith("/api/v1/")
            and request.method not in SAFE_METHODS
            and request.headers.get("x-local-token") != self.token
        ):
            return JSONResponse({"detail": "Missing or invalid local write token"}, status_code=403)
        return await call_next(request)


def create_local_token() -> str:
    return secrets.token_urlsafe(32)
