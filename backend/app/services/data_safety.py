from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
import shutil
import sqlite3
import uuid

from ..database import Database
from ..migrations import migrate_database


REQUIRED_TABLES = {"alembic_version", "settings", "agenda_items"}


def _database_fingerprint(path: Path) -> tuple[str, str]:
    """Validate a SQLite file and return its integrity result and schema revision."""
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError("备份文件不存在或为空")
    try:
        connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
        try:
            integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
            if integrity != "ok":
                raise ValueError(f"备份完整性检查失败：{integrity}")
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not REQUIRED_TABLES.issubset(tables):
                raise ValueError("文件不是 PersonalHub 数据库")
            revision_row = connection.execute("SELECT version_num FROM alembic_version").fetchone()
            # The first released schema created the Alembic table through
            # metadata before Alembic could write its marker. Keep those
            # databases compatible while still comparing schema generations.
            revision = str(revision_row[0]) if revision_row else "initial-schema"
            return integrity, revision
        finally:
            connection.close()
    except sqlite3.DatabaseError as exc:
        raise ValueError("备份文件损坏或不是 SQLite 数据库") from exc


def validate_database(path: Path) -> str:
    return _database_fingerprint(path)[1]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def describe_backup(path: Path) -> dict[str, object]:
    stat = path.stat()
    name = path.name
    if "_pre_restore_" in name:
        kind = "pre_restore"
    elif "_manual_" in name:
        kind = "manual"
    else:
        kind = "automatic"
    return {
        "name": name,
        "created_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        "size_bytes": stat.st_size,
        "sha256": _sha256(path),
        "kind": kind,
    }


def list_backups(directory: Path) -> list[dict[str, object]]:
    directory.mkdir(parents=True, exist_ok=True)
    paths = sorted(directory.glob("*.db"), key=lambda item: item.stat().st_mtime, reverse=True)
    return [describe_backup(path) for path in paths]


def create_backup(database_path: Path, directory: Path, kind: str = "manual") -> dict[str, object]:
    validate_database(database_path)
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    destination = directory / f"{stamp}_{kind}_{uuid.uuid4().hex[:6]}.db"
    temporary = destination.with_suffix(".tmp")
    try:
        source_connection = sqlite3.connect(database_path)
        target_connection = sqlite3.connect(temporary)
        try:
            source_connection.backup(target_connection)
        finally:
            target_connection.close()
            source_connection.close()
        validate_database(temporary)
        os.replace(temporary, destination)
        return describe_backup(destination)
    finally:
        temporary.unlink(missing_ok=True)


def resolve_backup(directory: Path, name: str) -> Path:
    if not name or Path(name).name != name or not name.endswith(".db"):
        raise ValueError("无效的备份文件名")
    candidate = (directory / name).resolve()
    if candidate.parent != directory.resolve() or not candidate.is_file():
        raise ValueError("备份文件不存在")
    return candidate


def restore_backup(database: Database, backup_path: Path, backup_directory: Path) -> tuple[Database, dict[str, object]]:
    """Restore through a validated temporary copy; never modify the selected backup."""
    database_path = database.path
    current_revision = validate_database(database_path)
    work = database_path.with_name(f"restore-{uuid.uuid4().hex}.db")
    rollback_copy = database_path.with_name(f"rollback-{uuid.uuid4().hex}.db")
    pre_restore: dict[str, object] | None = None
    try:
        shutil.copy2(backup_path, work)
        validate_database(work)
        migrate_database(work)
        if validate_database(work) != current_revision:
            raise ValueError("备份数据库版本与当前应用不兼容")

        pre_restore = create_backup(database_path, backup_directory, "pre_restore")
        with database.engine.begin() as connection:
            connection.exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE)")
        database.dispose()
        shutil.copy2(database_path, rollback_copy)
        for suffix in ("-wal", "-shm"):
            Path(f"{database_path}{suffix}").unlink(missing_ok=True)
        os.replace(work, database_path)
        try:
            replacement = Database(database_path)
            validate_database(database_path)
        except Exception:
            os.replace(rollback_copy, database_path)
            database.__init__(database_path)
            raise
        rollback_copy.unlink(missing_ok=True)
        return replacement, pre_restore
    finally:
        work.unlink(missing_ok=True)
        rollback_copy.unlink(missing_ok=True)
