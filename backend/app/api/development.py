from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .deps import get_session
from .utils import active_record, apply_changes, model_dict, soft_delete
from ..models import (
    AgendaItem, DevIssue, DevLog, DevMilestone, DevProject, DevRequirement,
    DevTask, new_id,
)
from ..schemas import (
    DevProjectCreate, DevProjectOut, DevProjectUpdate, DevTaskCreate,
    DevTaskOut, DevTaskUpdate,
)
from ..services.agenda import set_agenda_status


router = APIRouter(prefix="/dev", tags=["development"])


def project_out(session: Session, project: DevProject) -> DevProjectOut:
    total = session.scalar(select(func.count(DevTask.id)).where(
        DevTask.project_id == project.id, DevTask.deleted_at.is_(None)
    )) or 0
    done = session.scalar(select(func.count(DevTask.id)).where(
        DevTask.project_id == project.id,
        DevTask.workflow_status == "done",
        DevTask.deleted_at.is_(None),
    )) or 0
    data = DevProjectOut.model_validate(project).model_dump()
    data["progress"] = round(done * 100 / total) if total else 0
    return DevProjectOut(**data)


def task_out(session: Session, task: DevTask) -> DevTaskOut:
    data = DevTaskOut.model_validate(task).model_dump()
    if task.agenda_id:
        agenda = session.get(AgendaItem, task.agenda_id)
        if agenda:
            data.update(
                plan_date=agenda.plan_date,
                priority=agenda.priority,
                bucket=agenda.bucket,
                agenda_status=agenda.status,
            )
    return DevTaskOut(**data)


def active_project(session: Session, project_id: str) -> DevProject:
    project = session.get(DevProject, project_id)
    if not project or project.deleted_at is not None:
        raise HTTPException(404, "开发项目不存在")
    return project


@router.get("/projects", response_model=list[DevProjectOut])
def list_projects(session: Session = Depends(get_session)):
    projects = session.scalars(select(DevProject).where(
        DevProject.deleted_at.is_(None), DevProject.archived_at.is_(None)
    ).order_by(DevProject.updated_at.desc())).all()
    return [project_out(session, project) for project in projects]


@router.post("/projects", response_model=DevProjectOut, status_code=status.HTTP_201_CREATED)
def create_project(payload: DevProjectCreate, session: Session = Depends(get_session)):
    project = DevProject(**payload.model_dump())
    session.add(project)
    session.flush()
    return project_out(session, project)


@router.get("/projects/{project_id}", response_model=DevProjectOut)
def get_project(project_id: str, session: Session = Depends(get_session)):
    return project_out(session, active_project(session, project_id))


@router.patch("/projects/{project_id}", response_model=DevProjectOut)
def update_project(project_id: str, payload: DevProjectUpdate, session: Session = Depends(get_session)):
    project = active_project(session, project_id)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(project, key, value)
    session.flush()
    return project_out(session, project)


@router.delete("/projects/{project_id}", response_model=DevProjectOut)
def delete_project(project_id: str, session: Session = Depends(get_session)):
    project = active_project(session, project_id)
    project.deleted_at = datetime.now(timezone.utc)
    session.flush()
    return project_out(session, project)


@router.get("/projects/{project_id}/tasks", response_model=list[DevTaskOut])
def list_tasks(project_id: str, session: Session = Depends(get_session)):
    active_project(session, project_id)
    tasks = session.scalars(select(DevTask).where(
        DevTask.project_id == project_id, DevTask.deleted_at.is_(None)
    ).order_by(DevTask.created_at)).all()
    return [task_out(session, task) for task in tasks]


@router.post("/projects/{project_id}/tasks", response_model=DevTaskOut, status_code=status.HTTP_201_CREATED)
def create_task(project_id: str, payload: DevTaskCreate, session: Session = Depends(get_session)):
    active_project(session, project_id)
    task_id = new_id()
    task = DevTask(
        id=task_id,
        project_id=project_id,
        title=payload.title,
        description=payload.description,
        workflow_status=payload.workflow_status,
    )
    session.add(task)
    if payload.plan_date:
        agenda = AgendaItem(
            title=payload.title,
            plan_date=payload.plan_date,
            priority=payload.priority,
            bucket=payload.bucket,
            module="development",
            source_type="dev_task",
            source_id=task_id,
            status="completed" if payload.workflow_status == "done" else "pending",
        )
        session.add(agenda)
        session.flush()
        task.agenda_id = agenda.id
    session.flush()
    return task_out(session, task)


@router.patch("/tasks/{task_id}", response_model=DevTaskOut)
def update_task(task_id: str, payload: DevTaskUpdate, session: Session = Depends(get_session)):
    task = session.get(DevTask, task_id)
    if not task or task.deleted_at is not None:
        raise HTTPException(404, "开发任务不存在")
    values = payload.model_dump(exclude_unset=True)
    for key in ["title", "description", "workflow_status"]:
        if key in values:
            setattr(task, key, values[key])

    agenda = session.get(AgendaItem, task.agenda_id) if task.agenda_id else None
    if "plan_date" in values and values["plan_date"] is not None and not agenda:
        agenda = AgendaItem(
            title=task.title,
            plan_date=values["plan_date"],
            module="development",
            source_type="dev_task",
            source_id=task.id,
            priority=values.get("priority", "normal"),
            bucket=values.get("bucket", "scheduled"),
        )
        session.add(agenda)
        session.flush()
        task.agenda_id = agenda.id
    elif agenda:
        if "plan_date" in values and values["plan_date"] is not None:
            agenda.plan_date = values["plan_date"]
        if "priority" in values:
            agenda.priority = values["priority"]
        if "bucket" in values:
            agenda.bucket = values["bucket"]
        if "title" in values:
            agenda.title = task.title
    if agenda and "workflow_status" in values:
        set_agenda_status(session, agenda, "completed" if task.workflow_status == "done" else "pending")
    session.flush()
    return task_out(session, task)


@router.delete("/tasks/{task_id}", response_model=DevTaskOut)
def delete_task(task_id: str, session: Session = Depends(get_session)):
    task = session.get(DevTask, task_id)
    if not task or task.deleted_at is not None:
        raise HTTPException(404, "开发任务不存在")
    task.deleted_at = datetime.now(timezone.utc)
    if task.agenda_id:
        agenda = session.get(AgendaItem, task.agenda_id)
        if agenda:
            agenda.deleted_at = task.deleted_at
    session.flush()
    return task_out(session, task)


class RequirementIn(BaseModel):
    title: str = Field(min_length=1)
    description: str = ""
    status: str = "todo"
    priority: str = "normal"


class IssueIn(BaseModel):
    title: str = Field(min_length=1)
    issue_type: str = "bug"
    severity: str = "normal"
    is_blocking: bool = False
    status: Literal["open", "resolving", "resolved"] = "open"
    resolution: str = ""


class MilestoneIn(BaseModel):
    name: str = Field(min_length=1)
    target_date: date | None = None
    is_completed: bool = False


class LogIn(BaseModel):
    log_date: date
    completed_work: str = ""
    problems: str = ""
    decisions: str = ""


RESOURCE_CONFIG = {
    "requirements": (DevRequirement, {"title", "description", "status", "priority"}, "功能需求"),
    "issues": (DevIssue, {"title", "issue_type", "severity", "is_blocking", "status", "resolution"}, "问题记录"),
    "milestones": (DevMilestone, {"name", "target_date", "is_completed"}, "里程碑"),
    "logs": (DevLog, {"log_date", "completed_work", "problems", "decisions"}, "开发日志"),
}


def child_list(session: Session, model, project_id: str):
    active_project(session, project_id)
    return [model_dict(item) for item in session.scalars(select(model).where(
        model.project_id == project_id, model.deleted_at.is_(None)
    ).order_by(model.created_at)).all()]


@router.get("/projects/{project_id}/requirements")
def list_requirements(project_id: str, session: Session = Depends(get_session)):
    return child_list(session, DevRequirement, project_id)


@router.post("/projects/{project_id}/requirements", status_code=status.HTTP_201_CREATED)
def create_requirement(project_id: str, payload: RequirementIn, session: Session = Depends(get_session)):
    active_project(session, project_id)
    item = DevRequirement(project_id=project_id, **payload.model_dump())
    session.add(item); session.flush()
    return model_dict(item)


@router.get("/projects/{project_id}/issues")
def list_issues(project_id: str, session: Session = Depends(get_session)):
    return child_list(session, DevIssue, project_id)


@router.post("/projects/{project_id}/issues", status_code=status.HTTP_201_CREATED)
def create_issue(project_id: str, payload: IssueIn, session: Session = Depends(get_session)):
    active_project(session, project_id)
    item = DevIssue(project_id=project_id, **payload.model_dump())
    session.add(item); session.flush()
    return model_dict(item)


@router.get("/projects/{project_id}/milestones")
def list_milestones(project_id: str, session: Session = Depends(get_session)):
    return child_list(session, DevMilestone, project_id)


@router.post("/projects/{project_id}/milestones", status_code=status.HTTP_201_CREATED)
def create_milestone(project_id: str, payload: MilestoneIn, session: Session = Depends(get_session)):
    active_project(session, project_id)
    item = DevMilestone(project_id=project_id, **payload.model_dump())
    session.add(item); session.flush()
    return model_dict(item)


@router.get("/projects/{project_id}/logs")
def list_logs(project_id: str, session: Session = Depends(get_session)):
    return child_list(session, DevLog, project_id)


@router.post("/projects/{project_id}/logs", status_code=status.HTTP_201_CREATED)
def create_log(project_id: str, payload: LogIn, session: Session = Depends(get_session)):
    active_project(session, project_id)
    item = DevLog(project_id=project_id, **payload.model_dump())
    session.add(item); session.flush()
    return model_dict(item)


@router.patch("/{resource}/{record_id}")
def update_dev_resource(resource: str, record_id: str, payload: dict, session: Session = Depends(get_session)):
    if resource not in RESOURCE_CONFIG:
        raise HTTPException(404, "开发资源类型不存在")
    model, allowed, label = RESOURCE_CONFIG[resource]
    item = active_record(session, model, record_id, label)
    apply_changes(item, payload, allowed)
    session.flush()
    return model_dict(item)


@router.delete("/{resource}/{record_id}")
def delete_dev_resource(resource: str, record_id: str, session: Session = Depends(get_session)):
    if resource not in RESOURCE_CONFIG:
        raise HTTPException(404, "开发资源类型不存在")
    model, _allowed, label = RESOURCE_CONFIG[resource]
    item = active_record(session, model, record_id, label)
    soft_delete(item); session.flush()
    return model_dict(item)
