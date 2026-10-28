from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    AgendaItem, Consultation, ConsultationCommunication, ConsultationFollowup,
    ConsultationStage, DailyActivity, DailyHealthLog, DevIssue, DevLog, DevMilestone,
    DevProject, DevRequirement, DevTask, Dish,
    LearningGoal, LearningResource, LearningSection,
    LearningTask, MealPlan, MediaContent, QuickNote, ShoppingItem, ShoppingList,
    StudySession,
)


@dataclass(frozen=True)
class TrashType:
    model: type
    module: str
    label: str
    title: str | Callable[[Any], str]


TRASH_TYPES: dict[str, TrashType] = {
    "agenda": TrashType(AgendaItem, "today", "计划", "title"),
    "quick_note": TrashType(QuickNote, "home", "备忘", "content"),
    "daily_activity": TrashType(DailyActivity, "home", "日常记录", "content"),
    "media": TrashType(MediaContent, "media", "自媒体内容", "title"),
    "dev_project": TrashType(DevProject, "development", "开发项目", "name"),
    "dev_requirement": TrashType(DevRequirement, "development", "功能需求", "title"),
    "dev_task": TrashType(DevTask, "development", "开发任务", "title"),
    "dev_issue": TrashType(DevIssue, "development", "开发问题", "title"),
    "dev_milestone": TrashType(DevMilestone, "development", "里程碑", "name"),
    "dev_log": TrashType(DevLog, "development", "开发日志", lambda item: str(item.log_date)),
    "consultation": TrashType(Consultation, "consulting", "咨询", "title"),
    "consultation_stage": TrashType(ConsultationStage, "consulting", "方案阶段", "title"),
    "consultation_communication": TrashType(ConsultationCommunication, "consulting", "沟通记录", lambda item: item.content[:80]),
    "consultation_followup": TrashType(ConsultationFollowup, "consulting", "咨询跟进", "title"),
    "learning_goal": TrashType(LearningGoal, "learning", "学习目标", "name"),
    "learning_section": TrashType(LearningSection, "learning", "学习路线", "name"),
    "learning_task": TrashType(LearningTask, "learning", "学习任务", "title"),
    "study_session": TrashType(StudySession, "learning", "学习记录", lambda item: str(item.studied_on)),
    "learning_resource": TrashType(LearningResource, "learning", "学习资料", "name"),
    "dish": TrashType(Dish, "diet", "菜品", "name"),
    "meal": TrashType(MealPlan, "diet", "饮食安排", lambda item: item.custom_name or f"{item.meal_date} {item.meal_type}"),
    "health_log": TrashType(DailyHealthLog, "diet", "每日健康记录", lambda item: str(item.log_date)),
    "shopping_list": TrashType(ShoppingList, "diet", "购物清单", "name"),
    "shopping_item": TrashType(ShoppingItem, "diet", "购物项", "ingredient_name"),
}


PARENTS: dict[str, tuple[type, str]] = {
    "dev_requirement": (DevProject, "project_id"),
    "dev_task": (DevProject, "project_id"),
    "dev_issue": (DevProject, "project_id"),
    "dev_milestone": (DevProject, "project_id"),
    "dev_log": (DevProject, "project_id"),
    "consultation_stage": (Consultation, "consultation_id"),
    "consultation_communication": (Consultation, "consultation_id"),
    "consultation_followup": (Consultation, "consultation_id"),
    "learning_section": (LearningGoal, "goal_id"),
    "learning_task": (LearningGoal, "goal_id"),
    "study_session": (LearningGoal, "goal_id"),
    "learning_resource": (LearningGoal, "goal_id"),
    "shopping_item": (ShoppingList, "shopping_list_id"),
}


def _title(record: Any, descriptor: TrashType) -> str:
    value = descriptor.title(record) if callable(descriptor.title) else getattr(record, descriptor.title)
    return str(value or "未命名")[:160]


def trash_item(item_type: str, record: Any) -> dict[str, str]:
    descriptor = TRASH_TYPES[item_type]
    return {
        "type": item_type,
        "id": record.id,
        "module": descriptor.module,
        "label": descriptor.label,
        "title": _title(record, descriptor),
        "deleted_at": record.deleted_at.isoformat(),
    }


def list_trash(session: Session) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for item_type, descriptor in TRASH_TYPES.items():
        query = select(descriptor.model).where(descriptor.model.deleted_at.is_not(None))
        if descriptor.model is AgendaItem:
            query = query.where(AgendaItem.source_type.is_(None), AgendaItem.module != "games")
        records = session.scalars(query).all()
        items.extend(trash_item(item_type, record) for record in records)
    return sorted(items, key=lambda item: item["deleted_at"], reverse=True)


def get_deleted(session: Session, item_type: str, item_id: str):
    descriptor = TRASH_TYPES.get(item_type)
    if not descriptor:
        raise KeyError("未知的回收站类型")
    record = session.get(descriptor.model, item_id)
    if not record or record.deleted_at is None:
        raise LookupError("回收站项目不存在")
    if descriptor.model is AgendaItem and (
        record.module == "games" or record.source_type == "game_plan"
    ):
        raise LookupError("回收站项目不存在")
    return descriptor, record


def restore_trash(session: Session, item_type: str, item_id: str) -> dict[str, str]:
    descriptor, record = get_deleted(session, item_type, item_id)
    result = trash_item(item_type, record)
    record.deleted_at = None
    parent_info = PARENTS.get(item_type)
    if parent_info:
        parent_model, foreign_key = parent_info
        parent = session.get(parent_model, getattr(record, foreign_key))
        if parent:
            parent.deleted_at = None
    agenda_id = getattr(record, "agenda_id", None)
    if agenda_id:
        agenda = session.get(AgendaItem, agenda_id)
        if agenda:
            agenda.deleted_at = None
    session.flush()
    return result | {"deleted_at": ""}


def _delete_agenda_ids(session: Session, ids: list[str | None]) -> None:
    clean_ids = [item for item in ids if item]
    if clean_ids:
        for agenda in session.scalars(select(AgendaItem).where(AgendaItem.id.in_(clean_ids))).all():
            session.delete(agenda)


def _delete_descendant_agendas(session: Session, item_type: str, record: Any) -> None:
    if item_type == "dev_project":
        ids = session.scalars(select(DevTask.agenda_id).where(DevTask.project_id == record.id)).all()
    elif item_type == "consultation":
        ids = session.scalars(select(ConsultationFollowup.agenda_id).where(ConsultationFollowup.consultation_id == record.id)).all()
    elif item_type == "learning_goal":
        ids = session.scalars(select(LearningTask.agenda_id).where(LearningTask.goal_id == record.id)).all()
    else:
        ids = []
    _delete_agenda_ids(session, list(ids))


def purge_trash(session: Session, item_type: str, item_id: str) -> None:
    _descriptor, record = get_deleted(session, item_type, item_id)
    _delete_descendant_agendas(session, item_type, record)
    _delete_agenda_ids(session, [getattr(record, "agenda_id", None)])
    session.delete(record)
    session.flush()
