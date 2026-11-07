from datetime import date
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from .deps import get_session
from .utils import active_record
from ..models import LearningGoal
from ..services.learning_trends import learning_trends


router = APIRouter(prefix="/learning", tags=["learning"])


@router.get("/trends")
def trends(
    today: date,
    days: int = Query(default=7, ge=7, le=90),
    offset_minutes: int = Query(default=0, ge=-840, le=720),
    goal_id: str | None = Query(default=None, max_length=36),
    session: Session = Depends(get_session),
) -> dict:
    if days not in {7, 30, 90}:
        raise HTTPException(422, "学习趋势支持近7、30或90天")
    if goal_id:
        active_record(session, LearningGoal, goal_id, "学习目标")
    return learning_trends(session, today, days, offset_minutes, goal_id)
