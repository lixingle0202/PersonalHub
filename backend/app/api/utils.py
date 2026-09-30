from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, TypeVar

from fastapi import HTTPException
from sqlalchemy import inspect
from sqlalchemy.orm import Session


T = TypeVar("T")


def model_dict(instance: Any) -> dict[str, Any]:
    return {column.key: getattr(instance, column.key) for column in inspect(instance).mapper.column_attrs}


def active_record(session: Session, model: type[T], record_id: str, label: str) -> T:
    record = session.get(model, record_id)
    if not record or getattr(record, "deleted_at", None) is not None:
        raise HTTPException(404, f"{label}不存在")
    return record


def apply_changes(record: Any, values: dict[str, Any], allowed: set[str]) -> None:
    for key, value in values.items():
        if key in allowed:
            setattr(record, key, value)


def soft_delete(record: Any) -> None:
    record.deleted_at = datetime.now(timezone.utc)
