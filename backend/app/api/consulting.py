from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .deps import get_session
from .utils import active_record, apply_changes, model_dict, soft_delete
from ..models import (
    AgendaItem, Consultation, ConsultationCommunication, ConsultationFollowup,
    ConsultationStage, new_id,
)


router = APIRouter(prefix="/consultations", tags=["consulting"])
ConsultationStatus = Literal["intake", "analyzing", "drafting", "feedback", "completed"]


class ConsultationIn(BaseModel):
    title: str = Field(min_length=1)
    client_name: str = ""
    contact: str = ""
    original_question: str = ""
    stage: ConsultationStatus = "intake"
    background: str = ""
    goal: str = ""
    current_state: str = ""
    constraints: str = ""
    overall_advice: str = ""
    resources: str = ""
    notes: str = ""


class ConsultationPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1)
    client_name: str | None = None
    contact: str | None = None
    original_question: str | None = None
    stage: ConsultationStatus | None = None
    background: str | None = None
    goal: str | None = None
    current_state: str | None = None
    constraints: str | None = None
    overall_advice: str | None = None
    resources: str | None = None
    notes: str | None = None


class PlanStageIn(BaseModel):
    title: str = Field(min_length=1)
    goal: str = ""
    steps: str = ""
    schedule: str = ""
    sort_order: int = 0


class CommunicationIn(BaseModel):
    communicated_at: datetime | None = None
    content: str = ""
    feedback: str = ""
    changes: str = ""


class FollowupIn(BaseModel):
    title: str = Field(min_length=1)
    plan_date: date
    priority: str = "normal"


def consultation_out(session: Session, consultation: Consultation, detail: bool = False) -> dict:
    data = model_dict(consultation)
    followups = session.scalars(select(ConsultationFollowup).where(
        ConsultationFollowup.consultation_id == consultation.id,
        ConsultationFollowup.deleted_at.is_(None),
    ).order_by(ConsultationFollowup.created_at)).all()
    next_dates = []
    followup_data = []
    for followup in followups:
        row = model_dict(followup)
        agenda = session.get(AgendaItem, followup.agenda_id) if followup.agenda_id else None
        row["plan_date"] = agenda.plan_date if agenda else None
        row["status"] = agenda.status if agenda else None
        if agenda and agenda.status == "pending":
            next_dates.append(agenda.plan_date)
        followup_data.append(row)
    data["next_followup_date"] = min(next_dates) if next_dates else None
    if detail:
        data["plan_stages"] = [model_dict(item) for item in session.scalars(select(ConsultationStage).where(
            ConsultationStage.consultation_id == consultation.id,
            ConsultationStage.deleted_at.is_(None),
        ).order_by(ConsultationStage.sort_order)).all()]
        data["communications"] = [model_dict(item) for item in session.scalars(select(ConsultationCommunication).where(
            ConsultationCommunication.consultation_id == consultation.id,
            ConsultationCommunication.deleted_at.is_(None),
        ).order_by(ConsultationCommunication.communicated_at.desc())).all()]
        data["followups"] = followup_data
    return data


@router.get("")
def list_consultations(session: Session = Depends(get_session)):
    items = session.scalars(select(Consultation).where(
        Consultation.deleted_at.is_(None), Consultation.archived_at.is_(None)
    ).order_by(Consultation.updated_at.desc())).all()
    return [consultation_out(session, item) for item in items]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_consultation(payload: ConsultationIn, session: Session = Depends(get_session)):
    item = Consultation(**payload.model_dump())
    session.add(item); session.flush()
    return consultation_out(session, item, True)


@router.get("/{consultation_id}")
def get_consultation(consultation_id: str, session: Session = Depends(get_session)):
    return consultation_out(session, active_record(session, Consultation, consultation_id, "咨询"), True)


@router.patch("/{consultation_id}")
def update_consultation(consultation_id: str, payload: ConsultationPatch, session: Session = Depends(get_session)):
    item = active_record(session, Consultation, consultation_id, "咨询")
    apply_changes(item, payload.model_dump(exclude_unset=True), set(ConsultationPatch.model_fields))
    session.flush()
    return consultation_out(session, item, True)


@router.delete("/{consultation_id}")
def delete_consultation(consultation_id: str, session: Session = Depends(get_session)):
    item = active_record(session, Consultation, consultation_id, "咨询")
    soft_delete(item); session.flush()
    return consultation_out(session, item)


@router.post("/{consultation_id}/stages", status_code=status.HTTP_201_CREATED)
def add_stage(consultation_id: str, payload: PlanStageIn, session: Session = Depends(get_session)):
    active_record(session, Consultation, consultation_id, "咨询")
    item = ConsultationStage(consultation_id=consultation_id, **payload.model_dump())
    session.add(item); session.flush()
    return model_dict(item)


@router.post("/{consultation_id}/communications", status_code=status.HTTP_201_CREATED)
def add_communication(consultation_id: str, payload: CommunicationIn, session: Session = Depends(get_session)):
    active_record(session, Consultation, consultation_id, "咨询")
    values = payload.model_dump()
    if values["communicated_at"] is None:
        values.pop("communicated_at")
    item = ConsultationCommunication(consultation_id=consultation_id, **values)
    session.add(item); session.flush()
    return model_dict(item)


@router.post("/{consultation_id}/followups", status_code=status.HTTP_201_CREATED)
def add_followup(consultation_id: str, payload: FollowupIn, session: Session = Depends(get_session)):
    consultation = active_record(session, Consultation, consultation_id, "咨询")
    followup = ConsultationFollowup(id=new_id(), consultation_id=consultation_id, title=payload.title)
    session.add(followup)
    agenda = AgendaItem(
        title=payload.title, plan_date=payload.plan_date, priority=payload.priority,
        module="consulting", source_type="consultation_followup", source_id=followup.id,
        notes=f"咨询：{consultation.title}",
    )
    session.add(agenda); session.flush()
    followup.agenda_id = agenda.id
    session.flush()
    result = model_dict(followup)
    result.update(plan_date=agenda.plan_date, status=agenda.status)
    return result


@router.get("/{consultation_id}/copy-text")
def copy_text(consultation_id: str, session: Session = Depends(get_session)):
    item = active_record(session, Consultation, consultation_id, "咨询")
    stages = session.scalars(select(ConsultationStage).where(
        ConsultationStage.consultation_id == consultation_id,
        ConsultationStage.deleted_at.is_(None),
    ).order_by(ConsultationStage.sort_order)).all()
    parts = [
        f"# {item.title}",
        f"咨询问题：{item.original_question}",
        f"目标：{item.goal}",
        f"总体建议：{item.overall_advice}",
    ]
    for index, stage in enumerate(stages, 1):
        parts.append(f"\n## 阶段 {index}：{stage.title}\n目标：{stage.goal}\n步骤：{stage.steps}\n时间安排：{stage.schedule}")
    if item.resources:
        parts.append(f"\n## 推荐资料\n{item.resources}")
    return {"text": "\n".join(parts)}
