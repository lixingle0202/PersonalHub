"""An opt-in, account-isolated public entry point for the existing local app.

The owner's localhost service and database are never mounted here. Each public
account gets its own PersonalHub app and database; all of them use the model on
this computer through the server-side loopback address.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from contextlib import closing
from dataclasses import dataclass
from datetime import date
import hashlib
import os
from pathlib import Path
import re
import secrets
import sqlite3
from threading import RLock
import time
from urllib.parse import urlsplit
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field, field_validator

from .config import Settings
from .main import create_app
from .models import Setting
from .runtime_paths import frontend_dist_path, resource_root
from .services.ollama import OllamaSettings


COOKIE = "personalhub_public_session"
SESSION_SECONDS = 7 * 24 * 60 * 60
DAILY_GENERATIONS = 12
MODEL_URL = "http://127.0.0.1:11434"


@dataclass(frozen=True)
class PublicUser:
    id: str
    username: str


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=10, max_length=128)

    @field_validator("username")
    @classmethod
    def valid_username(cls, value: str) -> str:
        value = value.strip()
        if not re.fullmatch(r"[A-Za-z0-9_]{3,32}", value):
            raise ValueError("用户名须为 3 至 32 位英文字母、数字或下划线")
        return value


class AccountStore:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.lock = RLock()
        with closing(self.connect()) as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS accounts (
                    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
                    salt BLOB NOT NULL, password_hash BLOB NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES accounts(id)
                );
                CREATE TABLE IF NOT EXISTS model_usage (
                    user_id TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL,
                    PRIMARY KEY(user_id, day),
                    FOREIGN KEY(user_id) REFERENCES accounts(id)
                );
            """)

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    @staticmethod
    def password_hash(password: str, salt: bytes) -> bytes:
        return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 260_000)

    def register(self, credentials: Credentials) -> PublicUser:
        user = PublicUser(uuid.uuid4().hex, credentials.username)
        salt = secrets.token_bytes(16)
        with self.lock, closing(self.connect()) as connection, connection:
            try:
                connection.execute(
                    "INSERT INTO accounts VALUES (?, ?, ?, ?)",
                    (user.id, user.username.casefold(), salt, self.password_hash(credentials.password, salt)),
                )
            except sqlite3.IntegrityError as exc:
                raise HTTPException(409, "用户名已被使用") from exc
        return user

    def authenticate(self, credentials: Credentials) -> PublicUser | None:
        with closing(self.connect()) as connection:
            row = connection.execute(
                "SELECT id, username, salt, password_hash FROM accounts WHERE username=?",
                (credentials.username.casefold(),),
            ).fetchone()
        # The dummy hash keeps unknown-user and wrong-password timing similar.
        salt = row[2] if row else b"\x00" * 16
        candidate = self.password_hash(credentials.password, salt)
        if not row or not secrets.compare_digest(candidate, row[3]):
            return None
        return PublicUser(row[0], row[1])

    def new_session(self, user: PublicUser) -> str:
        token = secrets.token_urlsafe(32)
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self.lock, closing(self.connect()) as connection, connection:
            connection.execute("DELETE FROM sessions WHERE expires_at < ?", (int(time.time()),))
            connection.execute("INSERT INTO sessions VALUES (?, ?, ?)",
                               (digest, user.id, int(time.time()) + SESSION_SECONDS))
        return token

    def user_for(self, token: str | None) -> PublicUser | None:
        if not token:
            return None
        digest = hashlib.sha256(token.encode()).hexdigest()
        with closing(self.connect()) as connection:
            row = connection.execute("""
                SELECT accounts.id, accounts.username FROM sessions
                JOIN accounts ON accounts.id = sessions.user_id
                WHERE sessions.token_hash=? AND sessions.expires_at>?
            """, (digest, int(time.time()))).fetchone()
        return PublicUser(*row) if row else None

    def revoke(self, token: str | None) -> None:
        if token:
            with self.lock, closing(self.connect()) as connection, connection:
                connection.execute("DELETE FROM sessions WHERE token_hash=?",
                                   (hashlib.sha256(token.encode()).hexdigest(),))

    def reserve_generation(self, user_id: str) -> bool:
        today = date.today().isoformat()
        with self.lock, closing(self.connect()) as connection, connection:
            count = connection.execute(
                "SELECT count FROM model_usage WHERE user_id=? AND day=?", (user_id, today)
            ).fetchone()
            if count and count[0] >= DAILY_GENERATIONS:
                return False
            connection.execute("""
                INSERT INTO model_usage VALUES (?, ?, 1)
                ON CONFLICT(user_id, day) DO UPDATE SET count=count+1
            """, (user_id, today))
        return True

    def refund_generation(self, user_id: str) -> None:
        with self.lock, closing(self.connect()) as connection, connection:
            connection.execute("""
                UPDATE model_usage SET count=count-1
                WHERE user_id=? AND day=? AND count>0
            """, (user_id, date.today().isoformat()))


class PublicHub:
    def __init__(self, data_root: Path, model: str = "qwen2.5:1.5b", secure_cookie: bool = True):
        self.data_root = data_root.resolve()
        self.store = AccountStore(self.data_root / "accounts.sqlite3")
        self.model = model
        self.secure_cookie = secure_cookie
        self.user_apps: dict[str, FastAPI] = {}
        self.user_apps_lock = RLock()
        self.model_gate = asyncio.Lock()
        self.attempts: dict[str, list[float]] = defaultdict(list)
        self.attempts_lock = RLock()
        self.auth = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
        self._auth_routes()

    def _limit(self, key: str, count: int, window: int) -> None:
        now = time.monotonic()
        with self.attempts_lock:
            recent = [item for item in self.attempts[key] if now - item < window]
            if len(recent) >= count:
                raise HTTPException(429, "尝试过于频繁，请稍后重试")
            recent.append(now)
            self.attempts[key] = recent

    @staticmethod
    def _visitor(request: Request) -> str:
        return request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "unknown")

    def _auth_routes(self) -> None:
        @self.auth.post("/api/v1/public/register")
        def register(credentials: Credentials, request: Request):
            self._limit("register:" + self._visitor(request), 5, 3600)
            user = self.store.register(credentials)
            return self._session_response(user)

        @self.auth.post("/api/v1/public/login")
        def login(credentials: Credentials, request: Request):
            self._limit("login:" + self._visitor(request) + ":" + credentials.username.casefold(), 8, 900)
            user = self.store.authenticate(credentials)
            if not user:
                raise HTTPException(401, "用户名或密码错误")
            return self._session_response(user)

        @self.auth.post("/api/v1/public/logout")
        def logout(request: Request):
            self.store.revoke(request.cookies.get(COOKIE))
            response = JSONResponse({"ok": True}, headers={"Cache-Control": "no-store"})
            response.delete_cookie(COOKIE, path="/")
            return response

        @self.auth.get("/api/v1/public/me")
        def me(request: Request):
            user = self.store.user_for(request.cookies.get(COOKIE))
            if not user:
                raise HTTPException(401, "请先登录")
            return {"username": user.username}

    def _session_response(self, user: PublicUser) -> JSONResponse:
        response = JSONResponse({"username": user.username}, headers={"Cache-Control": "no-store"})
        response.set_cookie(COOKIE, self.store.new_session(user), max_age=SESSION_SECONDS,
                            httponly=True, secure=self.secure_cookie, samesite="strict", path="/")
        return response

    def _user_app(self, user: PublicUser) -> FastAPI:
        with self.user_apps_lock:
            app = self.user_apps.get(user.id)
            if app is None:
                settings = Settings(data_root=self.data_root / "users" / user.id,
                                    allowed_hosts=("*",))
                app = create_app(settings)
                with app.state.database.session() as session:
                    if session.get(Setting, "ai_ollama") is None:
                        session.add(Setting(key="ai_ollama", value_json=OllamaSettings(
                            base_url=MODEL_URL, model=self.model).model_dump_json()))
                self.user_apps[user.id] = app
            return app

    @staticmethod
    def _forbidden_origin(request: Request) -> bool:
        if request.method in {"GET", "HEAD", "OPTIONS"}:
            return False
        if request.headers.get("sec-fetch-site") == "cross-site":
            return True
        origin = request.headers.get("origin")
        return bool(origin and urlsplit(origin).netloc.casefold() != request.headers.get("host", "").casefold())

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    with self.user_apps_lock:
                        for app in self.user_apps.values():
                            app.state.database.dispose()
                        self.user_apps.clear()
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        if scope["type"] != "http":
            return
        request = Request(scope, receive)
        path = scope["path"]
        if self._forbidden_origin(request):
            return await JSONResponse({"detail": "跨站请求被拒绝"}, status_code=403)(scope, receive, send)
        if path == "/health":
            return await JSONResponse({"status": "ok", "mode": "public"})(scope, receive, send)
        if path.startswith("/api/v1/public/"):
            return await self.auth(scope, receive, send)
        if not path.startswith("/api/") and request.method in {"GET", "HEAD"}:
            # The login page and hashed frontend assets are public; app data is not.
            if path.startswith("/assets/") or "." not in Path(path).name:
                user = self.store.user_for(request.cookies.get(COOKIE))
                if not user:
                    root = frontend_dist_path().resolve()
                    relative = path.lstrip("/")
                    target = (root / relative).resolve()
                    if target.is_relative_to(root) and target.is_file():
                        return await FileResponse(target)(scope, receive, send)
                    return await FileResponse(root / "index.html", headers={"Cache-Control": "no-store"})(scope, receive, send)
        user = self.store.user_for(request.cookies.get(COOKIE))
        if not user:
            return await JSONResponse({"detail": "请先登录"}, status_code=401,
                                      headers={"Cache-Control": "no-store"})(scope, receive, send)
        app = self._user_app(user)
        if path == "/api/v1/bootstrap":
            return await JSONResponse({
                "app_name": "PersonalHub", "version": app.version,
                "local_token": app.state.local_token,
                "database_path": "独立个人空间", "public_mode": True, "username": user.username,
            }, headers={"Cache-Control": "no-store"})(scope, receive, send)
        if path == "/api/v1/ai/ollama/settings" and request.method != "GET":
            return await JSONResponse({"detail": "共享模型由服务端管理"}, status_code=403)(scope, receive, send)
        if path == "/api/v1/ai/ollama/models":
            return await JSONResponse({"detail": "共享模型由服务端管理"}, status_code=403)(scope, receive, send)
        if path == "/api/v1/ai/learning/generate" and request.method == "POST":
            if self.model_gate.locked():
                return await JSONResponse({"detail": "模型正在为其他人生成，请稍后重试"}, status_code=429)(scope, receive, send)
            await self.model_gate.acquire()
            reserved = False
            status = 500
            try:
                reserved = self.store.reserve_generation(user.id)
                if not reserved:
                    return await JSONResponse({"detail": "今天的生成次数已用完，请明天再试"}, status_code=429)(scope, receive, send)

                async def record_status(message):
                    nonlocal status
                    if message["type"] == "http.response.start":
                        status = message["status"]
                    await send(message)

                await app(scope, receive, record_status)
            finally:
                if reserved and status >= 400:
                    self.store.refund_generation(user.id)
                self.model_gate.release()
            return
        await app(scope, receive, send)


def create_public_app(data_root: Path | None = None, model: str | None = None,
                      secure_cookie: bool = True) -> PublicHub:
    return PublicHub(data_root or resource_root() / ".public-hub-data",
                     model or os.environ.get("PERSONAL_HUB_PUBLIC_MODEL", "qwen2.5:1.5b"),
                     secure_cookie=secure_cookie)
