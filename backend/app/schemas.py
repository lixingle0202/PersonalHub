from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


Priority = Literal["low", "normal", "high", "urgent"]
AgendaBucket = Literal["must", "scheduled", "optional"]
AgendaStatus = Literal["pending", "completed", "cancelled"]


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class AgendaCreate(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    plan_date: date
    start_time: str | None = None
    end_time: str | None = None
    priority: Priority = "normal"
    bucket: AgendaBucket = "scheduled"
    module: str = "general"
    notes: str = ""


class AgendaUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    plan_date: date | None = None
    start_time: str | None = None
    end_time: str | None = None
    priority: Priority | None = None
    bucket: AgendaBucket | None = None
    notes: str | None = None


class AgendaOut(ORMModel):
    id: str
    title: str
    plan_date: date
    start_time: str | None
    end_time: str | None
    priority: str
    bucket: str
    status: str
    sort_order: int
    module: str
    source_type: str | None
    source_id: str | None
    notes: str
    completed_at: datetime | None


class AgendaReorder(BaseModel):
    ordered_ids: list[str]


class AgendaReschedule(BaseModel):
    plan_date: date


class EndDayAction(BaseModel):
    item_id: str
    action: Literal["tomorrow", "reschedule", "cancel", "keep"]
    target_date: date | None = None


class EndDayRequest(BaseModel):
    date: date
    actions: list[EndDayAction]
    summary: str = ""


class DailyReviewIn(BaseModel):
    summary: str = ""


class DailyReviewOut(ORMModel):
    id: str
    review_date: date
    summary: str


class QuickNoteCreate(BaseModel):
    content: str = Field(min_length=1)
    is_important: bool = False


class QuickNoteUpdate(BaseModel):
    content: str | None = Field(default=None, min_length=1)
    is_important: bool | None = None
    is_archived: bool | None = None


class QuickNoteOut(ORMModel):
    id: str
    content: str
    is_important: bool
    is_archived: bool
    converted_type: str | None
    converted_id: str | None
    created_at: datetime


class QuickNoteConvert(BaseModel):
    target_type: Literal["agenda"]
    plan_date: date
    bucket: AgendaBucket = "scheduled"


class DevProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    goal: str = ""
    description: str = ""
    status: Literal["planned", "active", "paused", "completed"] = "planned"
    start_date: date | None = None
    due_date: date | None = None


class DevProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    goal: str | None = None
    description: str | None = None
    status: Literal["planned", "active", "paused", "completed"] | None = None
    start_date: date | None = None
    due_date: date | None = None


class DevProjectOut(ORMModel):
    id: str
    name: str
    goal: str
    description: str
    status: str
    start_date: date | None
    due_date: date | None
    progress: int = 0


class DevTaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    description: str = ""
    workflow_status: Literal["todo", "doing", "testing", "done"] = "todo"
    plan_date: date | None = None
    priority: Priority = "normal"
    bucket: AgendaBucket = "scheduled"


class DevTaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = None
    workflow_status: Literal["todo", "doing", "testing", "done"] | None = None
    plan_date: date | None = None
    priority: Priority | None = None
    bucket: AgendaBucket | None = None


class DevTaskOut(ORMModel):
    id: str
    project_id: str
    title: str
    description: str
    workflow_status: str
    agenda_id: str | None
    plan_date: date | None = None
    priority: str | None = None
    bucket: str | None = None
    agenda_status: str | None = None
