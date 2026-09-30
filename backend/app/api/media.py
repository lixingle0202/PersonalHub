from __future__ import annotations

from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .deps import get_session
from .utils import active_record, apply_changes, model_dict, soft_delete
from ..models import AgendaItem, MediaContent, MediaMetric, new_id
from ..services.agenda import set_agenda_status


router = APIRouter(prefix="/media", tags=["media"])
MediaStage = Literal["idea", "preparing", "creating", "ready", "published"]


class MediaCreate(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    platform: str = ""
    content_type: str = ""
    stage: MediaStage = "idea"
    outline: str = ""
    body: str = ""
    reference_links: str = ""
    publish_link: str = ""
    target_date: date | None = None
    notes: str = ""


class MediaUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    platform: str | None = None
    content_type: str | None = None
    stage: MediaStage | None = None
    outline: str | None = None
    body: str | None = None
    reference_links: str | None = None
    publish_link: str | None = None
    target_date: date | None = None
    published_at: date | None = None
    notes: str | None = None


class Transition(BaseModel):
    stage: MediaStage
    published_at: date | None = None
    publish_link: str | None = None


class MetricCreate(BaseModel):
    recorded_on: date
    views: int = Field(default=0, ge=0)
    likes: int = Field(default=0, ge=0)
    comments: int = Field(default=0, ge=0)
    favorites: int = Field(default=0, ge=0)


def media_out(session: Session, content: MediaContent) -> dict:
    data = model_dict(content)
    agenda = session.get(AgendaItem, content.agenda_id) if content.agenda_id else None
    data["target_date"] = agenda.plan_date if agenda else None
    data["agenda_status"] = agenda.status if agenda else None
    return data


@router.get("")
def list_media(stage: str | None = None, session: Session = Depends(get_session)):
    query = select(MediaContent).where(MediaContent.deleted_at.is_(None), MediaContent.archived_at.is_(None))
    if stage:
        query = query.where(MediaContent.stage == stage)
    contents = session.scalars(query.order_by(MediaContent.updated_at.desc())).all()
    return [media_out(session, item) for item in contents]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_media(payload: MediaCreate, session: Session = Depends(get_session)):
    values = payload.model_dump(exclude={"target_date"})
    content = MediaContent(id=new_id(), **values)
    session.add(content)
    if payload.target_date:
        agenda = AgendaItem(
            title=payload.title, plan_date=payload.target_date, module="media",
            source_type="media_content", source_id=content.id,
            status="completed" if payload.stage == "published" else "pending",
        )
        session.add(agenda)
        session.flush()
        content.agenda_id = agenda.id
    session.flush()
    return media_out(session, content)


@router.get("/{content_id}")
def get_media(content_id: str, session: Session = Depends(get_session)):
    return media_out(session, active_record(session, MediaContent, content_id, "自媒体内容"))


@router.patch("/{content_id}")
def update_media(content_id: str, payload: MediaUpdate, session: Session = Depends(get_session)):
    content = active_record(session, MediaContent, content_id, "自媒体内容")
    values = payload.model_dump(exclude_unset=True)
    target_present = "target_date" in values
    target_date = values.pop("target_date", None)
    apply_changes(content, values, {
        "title", "platform", "content_type", "stage", "outline", "body",
        "reference_links", "publish_link", "published_at", "notes",
    })
    agenda = session.get(AgendaItem, content.agenda_id) if content.agenda_id else None
    if target_present and target_date and not agenda:
        agenda = AgendaItem(
            title=content.title, plan_date=target_date, module="media",
            source_type="media_content", source_id=content.id,
        )
        session.add(agenda)
        session.flush()
        content.agenda_id = agenda.id
    elif agenda:
        if target_present and target_date:
            agenda.plan_date = target_date
        agenda.title = content.title
    if agenda and "stage" in values:
        set_agenda_status(session, agenda, "completed" if content.stage == "published" else "pending")
    session.flush()
    return media_out(session, content)


@router.post("/{content_id}/transition")
def transition_media(content_id: str, payload: Transition, session: Session = Depends(get_session)):
    content = active_record(session, MediaContent, content_id, "自媒体内容")
    content.stage = payload.stage
    if payload.publish_link is not None:
        content.publish_link = payload.publish_link
    if payload.stage == "published":
        content.published_at = payload.published_at or date.today()
    agenda = session.get(AgendaItem, content.agenda_id) if content.agenda_id else None
    if agenda:
        set_agenda_status(session, agenda, "completed" if payload.stage == "published" else "pending")
    session.flush()
    return media_out(session, content)


@router.delete("/{content_id}")
def delete_media(content_id: str, session: Session = Depends(get_session)):
    content = active_record(session, MediaContent, content_id, "自媒体内容")
    soft_delete(content)
    if content.agenda_id:
        agenda = session.get(AgendaItem, content.agenda_id)
        if agenda:
            agenda.deleted_at = content.deleted_at
    session.flush()
    return media_out(session, content)


@router.get("/{content_id}/metrics")
def list_metrics(content_id: str, session: Session = Depends(get_session)):
    active_record(session, MediaContent, content_id, "自媒体内容")
    return [model_dict(item) for item in session.scalars(
        select(MediaMetric).where(MediaMetric.content_id == content_id).order_by(MediaMetric.recorded_on.desc())
    ).all()]


@router.post("/{content_id}/metrics", status_code=status.HTTP_201_CREATED)
def create_metric(content_id: str, payload: MetricCreate, session: Session = Depends(get_session)):
    active_record(session, MediaContent, content_id, "自媒体内容")
    metric = MediaMetric(content_id=content_id, **payload.model_dump())
    session.add(metric)
    session.flush()
    return model_dict(metric)
