from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
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


def goal_out(session: Session, goal: LearningGoal, detail: bool = False) -> dict:
    data = model_dict(goal)
    sections = session.scalars(select(LearningSection).where(
        LearningSection.goal_id == goal.id, LearningSection.deleted_at.is_(None)
    ).order_by(LearningSection.sort_order)).all()
    parent_ids = {item.parent_id for item in sections if item.parent_id}
    leaves = [item for item in sections if item.id not in parent_ids]
    data["progress"] = round(sum(item.is_completed for item in leaves) * 100 / len(leaves)) if leaves else 0
    if detail:
        data["sections"] = [model_dict(item) for item in sections]
        tasks = session.scalars(select(LearningTask).where(
            LearningTask.goal_id == goal.id, LearningTask.deleted_at.is_(None)
        ).order_by(LearningTask.created_at)).all()
        task_rows = []
        for task in tasks:
            row = model_dict(task)
            agenda = session.get(AgendaItem, task.agenda_id) if task.agenda_id else None
            row.update(
                plan_date=agenda.plan_date if agenda else None,
                status=agenda.status if agenda else None,
                priority=agenda.priority if agenda else None,
            )
            task_rows.append(row)
        data["tasks"] = task_rows
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
    return goal_out(session, goal, True)


@router.get("/goals/{goal_id}")
def get_goal(goal_id: str, session: Session = Depends(get_session)):
    return goal_out(session, active_record(session, LearningGoal, goal_id, "学习目标"), True)


@router.patch("/goals/{goal_id}")
def update_goal(goal_id: str, payload: GoalIn, session: Session = Depends(get_session)):
    goal = active_record(session, LearningGoal, goal_id, "学习目标")
    apply_changes(goal, payload.model_dump(), set(GoalIn.model_fields)); session.flush()
    return goal_out(session, goal, True)


@router.delete("/goals/{goal_id}")
def delete_goal(goal_id: str, session: Session = Depends(get_session)):
    goal = active_record(session, LearningGoal, goal_id, "学习目标")
    soft_delete(goal); session.flush()
    return goal_out(session, goal)


@router.post("/goals/{goal_id}/sections", status_code=status.HTTP_201_CREATED)
def add_section(goal_id: str, payload: SectionIn, session: Session = Depends(get_session)):
    active_record(session, LearningGoal, goal_id, "学习目标")
    if payload.parent_id:
        parent = active_record(session, LearningSection, payload.parent_id, "父章节")
        if parent.goal_id != goal_id:
            raise HTTPException(422, "父章节不属于当前目标")
    item = LearningSection(goal_id=goal_id, **payload.model_dump())
    session.add(item); session.flush()
    return model_dict(item)


@router.post("/goals/{goal_id}/tasks", status_code=status.HTTP_201_CREATED)
def add_task(goal_id: str, payload: TaskIn, session: Session = Depends(get_session)):
    goal = active_record(session, LearningGoal, goal_id, "学习目标")
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
    return row


@router.post("/goals/{goal_id}/sessions", status_code=status.HTTP_201_CREATED)
def add_session(goal_id: str, payload: SessionIn, session: Session = Depends(get_session)):
    active_record(session, LearningGoal, goal_id, "学习目标")
    item = StudySession(goal_id=goal_id, **payload.model_dump())
    session.add(item); session.flush()
    return model_dict(item)


@router.post("/goals/{goal_id}/resources", status_code=status.HTTP_201_CREATED)
def add_resource(goal_id: str, payload: ResourceIn, session: Session = Depends(get_session)):
    active_record(session, LearningGoal, goal_id, "学习目标")
    item = LearningResource(goal_id=goal_id, **payload.model_dump())
    session.add(item); session.flush()
    return model_dict(item)


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
    apply_changes(item, payload, allowed)
    if resource == "tasks" and item.agenda_id and "title" in payload:
        session.get(AgendaItem, item.agenda_id).title = item.title
    session.flush()
    return model_dict(item)


@router.delete("/{resource}/{record_id}")
def delete_learning_resource(resource: str, record_id: str, session: Session = Depends(get_session)):
    if resource not in LEARNING_RESOURCES:
        raise HTTPException(404, "学习资源类型不存在")
    model, _allowed, label = LEARNING_RESOURCES[resource]
    item = active_record(session, model, record_id, label)
    soft_delete(item)
    if resource == "tasks" and item.agenda_id:
        agenda = session.get(AgendaItem, item.agenda_id)
        if agenda: agenda.deleted_at = item.deleted_at
    session.flush()
    return model_dict(item)
