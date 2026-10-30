from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy import exists, or_, select
from sqlalchemy.orm import Session

from .learning_links import linked_task_agendas

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
    "learning_section": TrashType(LearningSection, "learning", "学习阶段", "name"),
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


LEARNING_CHILDREN = {
    "learning_section": LearningSection,
    "learning_task": LearningTask,
    "study_session": StudySession,
    "learning_resource": LearningResource,
}


def trash_item(item_type: str, record: Any) -> dict[str, Any]:
    descriptor = TRASH_TYPES[item_type]
    return {
        "type": item_type,
        "id": record.id,
        "module": descriptor.module,
        "label": descriptor.label,
        "title": _title(record, descriptor),
        "deleted_at": record.deleted_at.isoformat() if record.deleted_at else "",
    }


def learning_children(session: Session, goal_id: str) -> list[tuple[str, Any]]:
    return [
        (item_type, record)
        for item_type, model in LEARNING_CHILDREN.items()
        for record in session.scalars(select(model).where(
            model.goal_id == goal_id, model.deleted_at.is_not(None)
        )).all()
    ]


def learning_group(goal: LearningGoal, children: list[dict[str, Any]]) -> dict[str, Any]:
    return trash_item("learning_goal", goal) | {
        "label": "学习计划",
        "deleted_at": max([goal.deleted_at.isoformat() if goal.deleted_at else "",
                           *(child["deleted_at"] for child in children)]),
        "goal_deleted": goal.deleted_at is not None,
        "parent_deleted": goal.deleted_at is not None,
        "details": goal.goal,
        "children": children,
    }


def shopping_group(shopping: ShoppingList, children: list[dict[str, Any]]) -> dict[str, Any]:
    return trash_item("shopping_list", shopping) | {
        "deleted_at": max([shopping.deleted_at.isoformat() if shopping.deleted_at else "",
                           *(child["deleted_at"] for child in children)]),
        "parent_deleted": shopping.deleted_at is not None,
        "details": f"采购日期：{shopping.start_date}—{shopping.end_date}",
        "children": sorted(children, key=lambda item: (item["title"], item["id"])),
    }


def list_trash(session: Session) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    by_goal: dict[str, list[dict[str, Any]]] = {}
    by_shopping: dict[str, list[dict[str, Any]]] = {}
    deleted_tasks: list[LearningTask] = []
    task_items: dict[str, dict[str, Any]] = {}
    for item_type, descriptor in TRASH_TYPES.items():
        if item_type in {"learning_goal", "shopping_list"}:
            continue
        query = select(descriptor.model).where(descriptor.model.deleted_at.is_not(None))
        if descriptor.model is AgendaItem:
            query = query.where(
                AgendaItem.source_type.is_(None), AgendaItem.module != "games",
                ~exists().where(LearningTask.agenda_id == AgendaItem.id),
            )
        records = session.scalars(query).all()
        for record in records:
            item = trash_item(item_type, record)
            if item_type in LEARNING_CHILDREN:
                item["details"] = getattr(record, "details", getattr(record, "notes", ""))
                if item_type == "study_session":
                    item["plan_date"] = record.studied_on.isoformat()
                by_goal.setdefault(record.goal_id, []).append(item)
                if item_type == "learning_task":
                    deleted_tasks.append(record)
                    task_items[record.id] = item
            elif item_type == "shopping_item":
                item.update(details=record.quantity_text,
                            status="completed" if record.is_completed else "pending")
                by_shopping.setdefault(record.shopping_list_id, []).append(item)
            else:
                items.append(item)

    agendas = linked_task_agendas(session, deleted_tasks)
    by_source = {agenda.source_id: agenda for agenda in agendas if agenda.source_type == "learning_task"}
    by_id = {agenda.id: agenda for agenda in agendas if agenda.source_type is None
             or (agenda.source_type == "learning_task" and agenda.source_id is None)}
    for task in deleted_tasks:
        agenda = by_source.get(task.id) or by_id.get(task.agenda_id)
        if agenda:
            task_items[task.id].update(plan_date=agenda.plan_date.isoformat(), status=agenda.status)

    goals = session.scalars(select(LearningGoal).where(or_(
        LearningGoal.deleted_at.is_not(None), LearningGoal.id.in_(by_goal)
    ))).all()
    for goal in goals:
        children = sorted(by_goal.get(goal.id, []), key=lambda item: (
            item.get("plan_date") or "9999", item["deleted_at"], item["id"]
        ))
        items.append(learning_group(goal, children))
    shopping_lists = session.scalars(select(ShoppingList).where(or_(
        ShoppingList.deleted_at.is_not(None), ShoppingList.id.in_(by_shopping)
    ))).all()
    for shopping in shopping_lists:
        items.append(shopping_group(shopping, by_shopping.get(shopping.id, [])))
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


def _restore_section_path(session: Session, section_id: str | None, goal_id: str) -> None:
    seen: set[str] = set()
    while section_id and section_id not in seen:
        seen.add(section_id)
        section = session.get(LearningSection, section_id)
        if not section or section.goal_id != goal_id:
            break
        section.deleted_at = None
        section_id = section.parent_id


def _restore_learning_links(session: Session, item_type: str, record: Any) -> None:
    if item_type == "learning_section":
        _restore_section_path(session, record.parent_id, record.goal_id)
    elif item_type == "learning_task":
        _restore_section_path(session, record.section_id, record.goal_id)
        agendas = linked_task_agendas(session, [record])
        # Prefer the canonical source row; restoring an old duplicate as well
        # would show the same task twice in today's plan.
        agenda = next((item for item in agendas if item.source_type == "learning_task"
                       and item.source_id == record.id), None)
        if agenda is None:
            agenda = next((item for item in agendas if item.id == record.agenda_id), None)
        if agenda:
            agenda.deleted_at = None


def restore_learning_plan(session: Session, goal_id: str) -> dict[str, Any]:
    goal = session.get(LearningGoal, goal_id)
    if not goal:
        raise LookupError("回收站学习计划不存在")
    children = learning_children(session, goal_id)
    if goal.deleted_at is None and not children:
        raise LookupError("回收站学习计划不存在")
    result = trash_item("learning_goal", goal)
    goal.deleted_at = None
    for item_type, child in children:
        child.deleted_at = None
        _restore_learning_links(session, item_type, child)
    # Older releases may have left active children under a deleted goal.
    for task in session.scalars(select(LearningTask).where(
        LearningTask.goal_id == goal_id, LearningTask.deleted_at.is_(None)
    )).all():
        _restore_learning_links(session, "learning_task", task)
    session.flush()
    return result | {"deleted_at": ""}


def restore_trash(session: Session, item_type: str, item_id: str) -> dict[str, Any]:
    if item_type == "learning_goal":
        return restore_learning_plan(session, item_id)
    if item_type == "shopping_list":
        shopping = session.get(ShoppingList, item_id)
        children = session.scalars(select(ShoppingItem).where(
            ShoppingItem.shopping_list_id == item_id, ShoppingItem.deleted_at.is_not(None)
        )).all()
        if not shopping or (shopping.deleted_at is None and not children):
            raise LookupError("回收站购物清单不存在")
        result = trash_item(item_type, shopping)
        shopping.deleted_at = None
        for child in children:
            child.deleted_at = None
        session.flush()
        return result | {"deleted_at": ""}
    descriptor, record = get_deleted(session, item_type, item_id)
    result = trash_item(item_type, record)
    record.deleted_at = None
    parent_info = PARENTS.get(item_type)
    if parent_info:
        parent_model, foreign_key = parent_info
        parent = session.get(parent_model, getattr(record, foreign_key))
        if parent:
            parent.deleted_at = None
    if item_type in LEARNING_CHILDREN:
        _restore_learning_links(session, item_type, record)
    agenda_id = getattr(record, "agenda_id", None) if item_type != "learning_task" else None
    if agenda_id:
        agenda = session.get(AgendaItem, agenda_id)
        if agenda:
            agenda.deleted_at = None
    session.flush()
    return result | {"deleted_at": ""}


def restore_category(session: Session, module: str) -> dict[str, Any]:
    if module not in {descriptor.module for descriptor in TRASH_TYPES.values()}:
        raise KeyError("未知的回收站大类")
    items = [item for item in list_trash(session) if item["module"] == module]
    if not items:
        raise LookupError("该大类没有可恢复的内容")
    for item in items:
        restore_trash(session, item["type"], item["id"])
    return {"module": module, "restored_groups": len(items)}


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
        tasks = list(session.scalars(select(LearningTask).where(LearningTask.goal_id == record.id)).all())
        ids = [agenda.id for agenda in linked_task_agendas(session, tasks)]
    else:
        ids = []
    _delete_agenda_ids(session, list(ids))


def purge_trash(session: Session, item_type: str, item_id: str) -> None:
    _descriptor, record = get_deleted(session, item_type, item_id)
    _delete_descendant_agendas(session, item_type, record)
    if item_type == "learning_task":
        _delete_agenda_ids(session, [agenda.id for agenda in linked_task_agendas(session, [record])])
    else:
        _delete_agenda_ids(session, [getattr(record, "agenda_id", None)])
    session.delete(record)
    session.flush()
