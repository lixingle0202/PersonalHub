from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from .deps import get_session
from ..models import AgendaItem, DailyReview, MealPlan, QuickNote
from ..schemas import (
    AgendaCreate, AgendaOut, AgendaReorder, AgendaReschedule, AgendaUpdate,
    DailyReviewIn, DailyReviewOut, EndDayRequest, QuickNoteConvert,
    QuickNoteCreate, QuickNoteOut, QuickNoteUpdate,
)
from ..services.agenda import set_agenda_status
from ..services.diet import delete_meal_plan


router = APIRouter(tags=["agenda"])


def active_item(session: Session, item_id: str) -> AgendaItem:
    item = session.get(AgendaItem, item_id)
    if (
        not item or item.deleted_at is not None or item.module == "games"
        or item.source_type == "game_plan"
    ):
        raise HTTPException(404, "计划事项不存在")
    return item


@router.get("/agenda", response_model=list[AgendaOut])
def list_agenda(date: str, session: Session = Depends(get_session)):
    return session.scalars(
        select(AgendaItem).where(
            AgendaItem.plan_date == date,
            AgendaItem.deleted_at.is_(None),
            AgendaItem.module != "games",
            or_(AgendaItem.source_type.is_(None), AgendaItem.source_type != "game_plan"),
        ).order_by(AgendaItem.sort_order, AgendaItem.start_time, AgendaItem.created_at)
    ).all()


@router.post("/agenda", response_model=AgendaOut, status_code=status.HTTP_201_CREATED)
def create_agenda(payload: AgendaCreate, session: Session = Depends(get_session)):
    if payload.module == "games":
        raise HTTPException(422, "游戏娱乐模块已移除")
    max_order = session.scalars(
        select(AgendaItem.sort_order).where(
            AgendaItem.plan_date == payload.plan_date,
            AgendaItem.bucket == payload.bucket,
        ).order_by(AgendaItem.sort_order.desc()).limit(1)
    ).first()
    item = AgendaItem(**payload.model_dump(), sort_order=(max_order or 0) + 1)
    session.add(item)
    session.flush()
    return item


@router.get("/agenda/{item_id}", response_model=AgendaOut)
def get_agenda(item_id: str, session: Session = Depends(get_session)):
    return active_item(session, item_id)


@router.patch("/agenda/{item_id}", response_model=AgendaOut)
def update_agenda(item_id: str, payload: AgendaUpdate, session: Session = Depends(get_session)):
    item = active_item(session, item_id)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(item, key, value)
    session.flush()
    return item


@router.delete("/agenda/{item_id}", response_model=AgendaOut)
def delete_agenda(item_id: str, session: Session = Depends(get_session)):
    from datetime import datetime, timezone
    item = active_item(session, item_id)
    meal_links = [MealPlan.agenda_id == item.id]
    if item.source_type == "meal_plan" and item.source_id:
        meal_links.append(MealPlan.id == item.source_id)
    meal = session.scalar(select(MealPlan).where(or_(*meal_links)))
    if meal:
        delete_meal_plan(session, meal)
        return item
    item.deleted_at = datetime.now(timezone.utc)
    session.flush()
    return item


@router.post("/agenda/{item_id}/complete", response_model=AgendaOut)
def complete_agenda(item_id: str, session: Session = Depends(get_session)):
    return set_agenda_status(session, active_item(session, item_id), "completed")


@router.post("/agenda/{item_id}/reopen", response_model=AgendaOut)
def reopen_agenda(item_id: str, session: Session = Depends(get_session)):
    return set_agenda_status(session, active_item(session, item_id), "pending")


@router.post("/agenda/{item_id}/cancel", response_model=AgendaOut)
def cancel_agenda(item_id: str, session: Session = Depends(get_session)):
    return set_agenda_status(session, active_item(session, item_id), "cancelled")


@router.post("/agenda/{item_id}/reschedule", response_model=AgendaOut)
def reschedule_agenda(item_id: str, payload: AgendaReschedule, session: Session = Depends(get_session)):
    item = active_item(session, item_id)
    item.plan_date = payload.plan_date
    item.status = "pending"
    item.completed_at = None
    session.flush()
    return item


@router.post("/agenda/reorder", response_model=list[AgendaOut])
def reorder_agenda(payload: AgendaReorder, session: Session = Depends(get_session)):
    items = session.scalars(select(AgendaItem).where(
        AgendaItem.id.in_(payload.ordered_ids),
        AgendaItem.deleted_at.is_(None),
        AgendaItem.module != "games",
        or_(AgendaItem.source_type.is_(None), AgendaItem.source_type != "game_plan"),
    )).all()
    by_id = {item.id: item for item in items}
    if len(by_id) != len(payload.ordered_ids):
        raise HTTPException(422, "排序列表中包含不存在的事项")
    for index, item_id in enumerate(payload.ordered_ids):
        by_id[item_id].sort_order = index
    session.flush()
    return [by_id[item_id] for item_id in payload.ordered_ids]


@router.post("/agenda/end-day")
def end_day(payload: EndDayRequest, session: Session = Depends(get_session)):
    tomorrow = payload.date + timedelta(days=1)
    for action in payload.actions:
        item = active_item(session, action.item_id)
        if item.plan_date != payload.date or item.status != "pending":
            raise HTTPException(409, f"事项 {item.title} 已发生变化，请刷新后重试")
        if action.action == "tomorrow":
            item.plan_date = tomorrow
        elif action.action == "reschedule":
            if not action.target_date:
                raise HTTPException(422, "重新安排必须选择日期")
            item.plan_date = action.target_date
        elif action.action == "cancel":
            set_agenda_status(session, item, "cancelled")
    review = session.scalar(select(DailyReview).where(DailyReview.review_date == payload.date))
    if review:
        review.summary = payload.summary
    else:
        review = DailyReview(review_date=payload.date, summary=payload.summary)
        session.add(review)
    session.flush()
    return {"processed": len(payload.actions), "review": DailyReviewOut.model_validate(review)}


@router.get("/daily-reviews/{review_date}", response_model=DailyReviewOut)
def get_review(review_date: str, session: Session = Depends(get_session)):
    review = session.scalar(select(DailyReview).where(DailyReview.review_date == review_date))
    if not review:
        raise HTTPException(404, "当天还没有总结")
    return review


@router.put("/daily-reviews/{review_date}", response_model=DailyReviewOut)
def put_review(review_date: str, payload: DailyReviewIn, session: Session = Depends(get_session)):
    review = session.scalar(select(DailyReview).where(DailyReview.review_date == review_date))
    if not review:
        review = DailyReview(review_date=review_date, summary=payload.summary)
        session.add(review)
    else:
        review.summary = payload.summary
    session.flush()
    return review


@router.get("/quick-notes", response_model=list[QuickNoteOut])
def list_quick_notes(session: Session = Depends(get_session)):
    return session.scalars(
        select(QuickNote).where(
            QuickNote.deleted_at.is_(None), QuickNote.is_archived.is_(False)
        ).order_by(QuickNote.is_important.desc(), QuickNote.created_at.desc())
    ).all()


@router.post("/quick-notes", response_model=QuickNoteOut, status_code=status.HTTP_201_CREATED)
def create_quick_note(payload: QuickNoteCreate, session: Session = Depends(get_session)):
    note = QuickNote(**payload.model_dump())
    session.add(note)
    session.flush()
    return note


@router.patch("/quick-notes/{note_id}", response_model=QuickNoteOut)
def update_quick_note(note_id: str, payload: QuickNoteUpdate, session: Session = Depends(get_session)):
    note = session.get(QuickNote, note_id)
    if not note or note.deleted_at is not None:
        raise HTTPException(404, "备忘不存在")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(note, key, value)
    session.flush()
    return note


@router.post("/quick-notes/{note_id}/convert", response_model=AgendaOut)
def convert_quick_note(note_id: str, payload: QuickNoteConvert, session: Session = Depends(get_session)):
    note = session.get(QuickNote, note_id)
    if not note or note.deleted_at is not None:
        raise HTTPException(404, "备忘不存在")
    if note.converted_id:
        raise HTTPException(409, "该备忘已经整理过")
    item = AgendaItem(title=note.content, plan_date=payload.plan_date, bucket=payload.bucket)
    session.add(item)
    session.flush()
    note.converted_type = "agenda"
    note.converted_id = item.id
    note.is_archived = True
    session.flush()
    return item


@router.delete("/quick-notes/{note_id}", response_model=QuickNoteOut)
def delete_quick_note(note_id: str, session: Session = Depends(get_session)):
    from datetime import datetime, timezone
    note = session.get(QuickNote, note_id)
    if not note or note.deleted_at is not None:
        raise HTTPException(404, "备忘不存在")
    note.deleted_at = datetime.now(timezone.utc)
    session.flush()
    return note
