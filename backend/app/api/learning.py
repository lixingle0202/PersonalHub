from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .deps import get_session
from .utils import active_record, apply_changes, model_dict, soft_delete
from ..models import (
    AgendaItem, LearningGoal, LearningResource, LearningSection, LearningTask,
    StudySession, new_id,
)


router = APIRouter(prefix="/learning", tags=["learning"])


class GoalIn(BaseModel):
    name: str = Field(min_length=1)
    goal: str = ""
    start_date: date | None = None
    target_date: date | None = None
    estimated_minutes: int = Field(default=0, ge=0)


class GoalUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    goal: str | None = None
    start_date: date | None = None
    target_date: date | None = None
    estimated_minutes: int | None = Field(default=None, ge=0)
    progress: int | None = Field(default=None, ge=0, le=100)

    @field_validator("name")
    @classmethod
    def name_cannot_be_empty(cls, value: str | None) -> str:
        if value is None or not value.strip():
            raise ValueError("学习主题不能为空")
        return value

    @field_validator("goal")
    @classmethod
    def clear_goal(cls, value: str | None) -> str:
        return value or ""

    @field_validator("estimated_minutes")
    @classmethod
    def clear_estimated_minutes(cls, value: int | None) -> int:
        return value if value is not None else 0


class SectionIn(BaseModel):
    name: str = Field(min_length=1)
    parent_id: str | None = None
    sort_order: int = 0
    is_completed: bool = False


class TaskIn(BaseModel):
    title: str = Field(min_length=1)
    section_id: str | None = None
    plan_date: date | None = None
    priority: str = "normal"


class TaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    section_id: str | None = None
    plan_date: date | None = None

    @field_validator("title")
    @classmethod
    def title_cannot_be_null(cls, value: str | None) -> str:
        if value is None or not value.strip():
            raise ValueError("学习任务名称不能为空")
        return value


class SessionIn(BaseModel):
    studied_on: date
    actual_minutes: int = Field(ge=0)
    notes: str = ""
    problems: str = ""
    next_step: str = ""


class ResourceIn(BaseModel):
    name: str = Field(min_length=1)
    link: str = ""
    notes: str = ""


def commit_response(session: Session, result: dict) -> dict:
    # Request-scoped dependency teardown happens after the response is sent.
    session.commit()
    return result


def linked_task_agendas(session: Session, tasks: list[LearningTask]) -> list[AgendaItem]:
    """Find forward and legacy reverse links without changing another source's agenda."""
    if not tasks:
        return []
    task_ids = [task.id for task in tasks]
    agenda_ids = [task.agenda_id for task in tasks if task.agenda_id]
    owns_source = (AgendaItem.source_type == "learning_task") & AgendaItem.source_id.in_(task_ids)
    legacy_forward = AgendaItem.id.in_(agenda_ids) & or_(
        AgendaItem.source_type.is_(None),
        (AgendaItem.source_type == "learning_task") & AgendaItem.source_id.is_(None),
    )
    return list(session.scalars(select(AgendaItem).where(or_(owns_source, legacy_forward))).all())


def task_out(session: Session, task: LearningTask) -> dict:
    row = model_dict(task)
    agendas = linked_task_agendas(session, [task])
    agenda = next((item for item in agendas if item.deleted_at is None and item.id == task.agenda_id), None)
    if agenda is None:
        agenda = next((item for item in agendas if item.deleted_at is None), None)
    row.update(
        agenda_id=agenda.id if agenda else None,
        plan_date=agenda.plan_date if agenda else None,
        status=agenda.status if agenda else None,
        priority=agenda.priority if agenda else None,
    )
    return row


def validate_section(session: Session, section_id: str | None, goal_id: str) -> None:
    if section_id is not None:
        section = active_record(session, LearningSection, section_id, "学习章节")
        if section.goal_id != goal_id:
            raise HTTPException(422, "学习章节不属于当前目标")


def goal_out(session: Session, goal: LearningGoal, detail: bool = False) -> dict:
    data = model_dict(goal)
    manual_progress = data.pop("progress_override", None)
    sections = session.scalars(select(LearningSection).where(
        LearningSection.goal_id == goal.id, LearningSection.deleted_at.is_(None)
    ).order_by(LearningSection.sort_order)).all()
    parent_ids = {item.parent_id for item in sections if item.parent_id}
    leaves = [item for item in sections if item.id not in parent_ids]
    automatic_progress = round(sum(item.is_completed for item in leaves) * 100 / len(leaves)) if leaves else 0
    data["progress"] = manual_progress if manual_progress is not None else automatic_progress
    data["progress_is_manual"] = manual_progress is not None
    if detail:
        data["sections"] = [model_dict(item) for item in sections]
        tasks = session.scalars(select(LearningTask).where(
            LearningTask.goal_id == goal.id, LearningTask.deleted_at.is_(None)
        ).order_by(LearningTask.created_at)).all()
        data["tasks"] = [task_out(session, task) for task in tasks]
        data["sessions"] = [model_dict(item) for item in session.scalars(select(StudySession).where(
            StudySession.goal_id == goal.id, StudySession.deleted_at.is_(None)
        ).order_by(StudySession.studied_on.desc())).all()]
        data["resources"] = [model_dict(item) for item in session.scalars(select(LearningResource).where(
            LearningResource.goal_id == goal.id, LearningResource.deleted_at.is_(None)
        ).order_by(LearningResource.created_at)).all()]
    return data


@router.get("/goals")
def list_goals(session: Session = Depends(get_session)):
    goals = session.scalars(select(LearningGoal).where(
        LearningGoal.deleted_at.is_(None), LearningGoal.archived_at.is_(None)
    ).order_by(LearningGoal.updated_at.desc())).all()
    return [goal_out(session, goal) for goal in goals]


@router.post("/goals", status_code=status.HTTP_201_CREATED)
def create_goal(payload: GoalIn, session: Session = Depends(get_session)):
    goal = LearningGoal(**payload.model_dump())
    session.add(goal); session.flush()
    return commit_response(session, goal_out(session, goal, True))




@router.get("/goals/{goal_id}")
def get_goal(goal_id: str, session: Session = Depends(get_session)):
    return goal_out(session, active_record(session, LearningGoal, goal_id, "学习目标"), True)


@router.patch("/goals/{goal_id}")
def update_goal(goal_id: str, payload: GoalUpdate, session: Session = Depends(get_session)):
    goal = active_record(session, LearningGoal, goal_id, "学习目标")
    previous_name = goal.name
    changes = payload.model_dump(exclude_unset=True)
    if "progress" in changes:
        goal.progress_override = changes.pop("progress")
    apply_changes(goal, changes, {"name", "goal", "start_date", "target_date", "estimated_minutes"})
    if goal.name != previous_name:
        tasks = list(session.scalars(select(LearningTask).where(LearningTask.goal_id == goal.id)).all())
        prefix = f"学习目标：{previous_name}"
        for agenda in linked_task_agendas(session, tasks):
            if agenda.notes == prefix or agenda.notes.startswith(prefix + "\n"):
                agenda.notes = f"学习目标：{goal.name}" + agenda.notes[len(prefix):]
    session.flush()
    result = goal_out(session, goal, True)
    return commit_response(session, result)


@router.delete("/goals/{goal_id}")
def delete_goal(goal_id: str, session: Session = Depends(get_session)):
    goal = active_record(session, LearningGoal, goal_id, "学习目标")
    # Include previously deleted tasks when finding agendas left by older releases.
    tasks = list(session.scalars(select(LearningTask).where(LearningTask.goal_id == goal_id)).all())
    children = [*tasks]
    for model in (LearningSection, StudySession, LearningResource):
        children.extend(session.scalars(select(model).where(model.goal_id == goal_id)).all())
    soft_delete(goal)
    for item in [*children, *linked_task_agendas(session, tasks)]:
        if item.deleted_at is None:
            item.deleted_at = goal.deleted_at
    session.flush()
    result = goal_out(session, goal)
    return commit_response(session, result)


@router.post("/goals/{goal_id}/sections", status_code=status.HTTP_201_CREATED)
def add_section(goal_id: str, payload: SectionIn, session: Session = Depends(get_session)):
    active_record(session, LearningGoal, goal_id, "学习目标")
    if payload.parent_id:
        parent = active_record(session, LearningSection, payload.parent_id, "父章节")
        if parent.goal_id != goal_id:
            raise HTTPException(422, "父章节不属于当前目标")
    item = LearningSection(goal_id=goal_id, **payload.model_dump())
    session.add(item); session.flush()
    return commit_response(session, model_dict(item))


@router.post("/goals/{goal_id}/tasks", status_code=status.HTTP_201_CREATED)
def add_task(goal_id: str, payload: TaskIn, session: Session = Depends(get_session)):
    goal = active_record(session, LearningGoal, goal_id, "学习目标")
    validate_section(session, payload.section_id, goal_id)
    task = LearningTask(id=new_id(), goal_id=goal_id, section_id=payload.section_id, title=payload.title)
    session.add(task)
    if payload.plan_date:
        agenda = AgendaItem(
            title=payload.title, plan_date=payload.plan_date, priority=payload.priority,
            module="learning", source_type="learning_task", source_id=task.id,
            notes=f"学习目标：{goal.name}",
        )
        session.add(agenda); session.flush(); task.agenda_id = agenda.id
    session.flush()
    row = model_dict(task)
    row.update(plan_date=payload.plan_date, status="pending" if payload.plan_date else None, priority=payload.priority)
    return commit_response(session, row)


@router.patch("/tasks/{task_id}")
def update_task(task_id: str, payload: TaskUpdate, session: Session = Depends(get_session)):
    task = active_record(session, LearningTask, task_id, "学习任务")
    goal = active_record(session, LearningGoal, task.goal_id, "学习目标")
    changes = payload.model_dump(exclude_unset=True)
    if "section_id" in changes:
        validate_section(session, changes["section_id"], goal.id)
    apply_changes(task, changes, {"title", "section_id"})
    agendas = linked_task_agendas(session, [task])
    if "plan_date" in changes:
        if changes["plan_date"] is None:
            for agenda in agendas:
                if agenda.deleted_at is None:
                    soft_delete(agenda)
            task.agenda_id = None
        else:
            # Reuse the unique source row even after clearing a previous schedule.
            agenda = next((item for item in agendas if item.source_type == "learning_task" and item.source_id == task.id), None)
            if agenda is None:
                agenda = next((item for item in agendas if item.id == task.agenda_id), None)
            if agenda is None:
                agenda = AgendaItem(module="learning", source_type="learning_task", source_id=task.id,
                                    notes=f"学习目标：{goal.name}")
                session.add(agenda)
            agenda.title = task.title
            agenda.plan_date = changes["plan_date"]
            agenda.module = "learning"
            agenda.source_type = "learning_task"
            agenda.source_id = task.id
            agenda.deleted_at = None
            agenda.archived_at = None
            session.flush()
            task.agenda_id = agenda.id
            for other in agendas:
                if other is not agenda and other.deleted_at is None:
                    soft_delete(other)
    elif "title" in changes:
        for agenda in agendas:
            agenda.title = task.title
        active_agenda = next((agenda for agenda in agendas if agenda.deleted_at is None), None)
        if active_agenda:
            task.agenda_id = active_agenda.id
    session.flush()
    result = task_out(session, task)
    return commit_response(session, result)


@router.post("/goals/{goal_id}/sessions", status_code=status.HTTP_201_CREATED)
def add_session(goal_id: str, payload: SessionIn, session: Session = Depends(get_session)):
    active_record(session, LearningGoal, goal_id, "学习目标")
    item = StudySession(goal_id=goal_id, **payload.model_dump())
    session.add(item); session.flush()
    return commit_response(session, model_dict(item))


@router.post("/goals/{goal_id}/resources", status_code=status.HTTP_201_CREATED)
def add_resource(goal_id: str, payload: ResourceIn, session: Session = Depends(get_session)):
    active_record(session, LearningGoal, goal_id, "学习目标")
    item = LearningResource(goal_id=goal_id, **payload.model_dump())
    session.add(item); session.flush()
    return commit_response(session, model_dict(item))


LEARNING_RESOURCES = {
    "sections": (LearningSection, {"name", "parent_id", "sort_order", "is_completed"}, "学习章节"),
    "tasks": (LearningTask, {"title", "section_id"}, "学习任务"),
    "sessions": (StudySession, {"studied_on", "actual_minutes", "notes", "problems", "next_step"}, "学习记录"),
    "resources": (LearningResource, {"name", "link", "notes"}, "学习资料"),
}


@router.patch("/{resource}/{record_id}")
def update_learning_resource(resource: str, record_id: str, payload: dict, session: Session = Depends(get_session)):
    if resource not in LEARNING_RESOURCES:
        raise HTTPException(404, "学习资源类型不存在")
    model, allowed, label = LEARNING_RESOURCES[resource]
    item = active_record(session, model, record_id, label)
    active_record(session, LearningGoal, item.goal_id, "学习目标")
    if resource == "sections" and payload.get("parent_id"):
        validate_section(session, payload["parent_id"], item.goal_id)
        if payload["parent_id"] == item.id:
            raise HTTPException(422, "章节不能作为自己的父章节")
    apply_changes(item, payload, allowed)
    session.flush()
    return commit_response(session, model_dict(item))


@router.delete("/{resource}/{record_id}")
def delete_learning_resource(resource: str, record_id: str, session: Session = Depends(get_session)):
    if resource not in LEARNING_RESOURCES:
        raise HTTPException(404, "学习资源类型不存在")
    model, _allowed, label = LEARNING_RESOURCES[resource]
    item = active_record(session, model, record_id, label)
    soft_delete(item)
    if resource == "tasks":
        for agenda in linked_task_agendas(session, [item]):
            if agenda.deleted_at is None:
                agenda.deleted_at = item.deleted_at
    session.flush()
    result = model_dict(item)
    return commit_response(session, result)
