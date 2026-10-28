from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from .deps import get_session
from ..models import DailyActivity
from ..schemas import DailyActivityOut, DailyActivityUpdate, DailyNarrationIn, DailyNarrationOut
from ..services.daily_activities import split_narration


router = APIRouter(prefix='/daily-activities', tags=['daily-activities'])


@router.get('', response_model=list[DailyActivityOut])
def list_activities(activity_date: date = Query(alias='date'), session: Session = Depends(get_session)):
    return session.scalars(select(DailyActivity).where(
        DailyActivity.activity_date == activity_date, DailyActivity.deleted_at.is_(None),
    ).order_by(DailyActivity.created_at, DailyActivity.sort_order, DailyActivity.id)).all()


@router.post('/narrate', response_model=DailyNarrationOut, status_code=201)
def narrate(payload: DailyNarrationIn, request: Request, response: Response, session: Session = Depends(get_session)):
    activities, skipped = split_narration(payload.text)
    if len(activities) > 50:
        raise HTTPException(422, '一次最多记录50件事，请分段提交')
    with request.app.state.data_lock:
        existing = session.scalars(select(DailyActivity).where(
            DailyActivity.batch_id == str(payload.request_id),
        ).order_by(DailyActivity.sort_order)).all()
        if existing:
            if any(row.source_text != payload.text or row.source_date != payload.activity_date for row in existing):
                raise HTTPException(409, '该次记录已保存，请使用新的提交记录其他内容')
            response.status_code = 200
            return {'items': [row for row in existing if row.deleted_at is None], 'skipped': skipped, 'created': False}
        if not activities:
            response.status_code = 200
            return {'items': [], 'skipped': skipped, 'created': False}
        rows = [DailyActivity(activity_date=payload.activity_date, content=activity.content,
            category=activity.category, source_text=payload.text, source_date=payload.activity_date,
            batch_id=str(payload.request_id), sort_order=index)
            for index, activity in enumerate(activities)]
        session.add_all(rows)
        session.flush()
        # Commit under the lock so a retry cannot observe a half-written batch.
        session.commit()
        return {'items': rows, 'skipped': skipped, 'created': True}


def active_activity(session: Session, item_id: str) -> DailyActivity:
    item = session.get(DailyActivity, item_id)
    if not item or item.deleted_at is not None:
        raise HTTPException(404, '日常记录不存在')
    return item


@router.patch('/{item_id}', response_model=DailyActivityOut)
def update_activity(item_id: str, payload: DailyActivityUpdate, session: Session = Depends(get_session)):
    item = active_activity(session, item_id)
    for key, value in payload.model_dump().items():
        setattr(item, key, value)
    session.flush()
    return item


@router.delete('/{item_id}', response_model=DailyActivityOut)
def delete_activity(item_id: str, session: Session = Depends(get_session)):
    item = active_activity(session, item_id)
    item.deleted_at = datetime.now(timezone.utc)
    session.flush()
    return item
