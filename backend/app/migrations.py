from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config

from .database import sqlite_url
from .runtime_paths import backend_resource_path


def migration_config(database_path: Path) -> Config:
    backend_root = backend_resource_path()
    config = Config(str(backend_root / "alembic.ini"))
    config.set_main_option("script_location", str(backend_root / "migrations"))
    config.set_main_option("sqlalchemy.url", sqlite_url(database_path))
    return config


def migrate_database(database_path: Path) -> None:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    command.upgrade(migration_config(database_path), "head")
