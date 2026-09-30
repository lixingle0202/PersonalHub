from __future__ import annotations

from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .deps import get_session
from .utils import active_record, apply_changes, model_dict, soft_delete
from ..models import AgendaItem, EntertainmentBudget, Game, GamePlan, GameSession, new_id


router = APIRouter(prefix="/games", tags=["games"])
GameStatus = Literal["wishlist", "playing", "completed", "paused"]


class GameIn(BaseModel):
    name: str = Field(min_length=1)
    platform: str = ""
    genre: str = ""
    status: GameStatus = "wishlist"
    progress: str = ""
    next_goal: str = ""
    notes: str = ""
    rating: float | None = Field(default=None, ge=0, le=10)


class PlanIn(BaseModel):
    plan_date: date
    planned_minutes: int = Field(default=0, ge=0)


class SessionIn(BaseModel):
    played_on: date
    actual_minutes: int = Field(ge=0)
    notes: str = ""


class BudgetIn(BaseModel):
    period_type: Literal["daily", "weekly"]
    minute_limit: int = Field(gt=0)
    starts_on: date


def game_out(session: Session, game: Game, detail: bool = False) -> dict:
    data = model_dict(game)
    if detail:
        plans = session.scalars(select(GamePlan).where(
            GamePlan.game_id == game.id, GamePlan.deleted_at.is_(None)
        ).order_by(GamePlan.created_at.desc())).all()
        plan_rows = []
        for plan in plans:
            row = model_dict(plan)
            agenda = session.get(AgendaItem, plan.agenda_id)
            row.update(
                plan_date=agenda.plan_date if agenda else None,
                status=agenda.status if agenda else None,
            )
            plan_rows.append(row)
        data["plans"] = plan_rows
        data["sessions"] = [model_dict(item) for item in session.scalars(select(GameSession).where(
            GameSession.game_id == game.id, GameSession.deleted_at.is_(None)
        ).order_by(GameSession.played_on.desc())).all()]
    return data


@router.get("")
def list_games(session: Session = Depends(get_session)):
    return [game_out(session, item) for item in session.scalars(select(Game).where(
        Game.deleted_at.is_(None), Game.archived_at.is_(None)
    ).order_by(Game.updated_at.desc())).all()]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_game(payload: GameIn, session: Session = Depends(get_session)):
    game = Game(**payload.model_dump()); session.add(game); session.flush()
    return game_out(session, game, True)


@router.get("/budget")
def get_budget(period_type: Literal["daily", "weekly"] = "weekly", on: date | None = None, session: Session = Depends(get_session)):
    target = on or date.today()
    budget = session.scalar(select(EntertainmentBudget).where(
        EntertainmentBudget.period_type == period_type,
        EntertainmentBudget.deleted_at.is_(None),
    ).order_by(EntertainmentBudget.starts_on.desc()).limit(1))
    if period_type == "daily":
        start = end = target
    else:
        start = target - timedelta(days=target.weekday())
        end = start + timedelta(days=6)
    used = session.scalar(select(func.coalesce(func.sum(GameSession.actual_minutes), 0)).where(
        GameSession.played_on >= start, GameSession.played_on <= end,
        GameSession.deleted_at.is_(None),
    )) or 0
    return {
        "period_type": period_type,
        "minute_limit": budget.minute_limit if budget else 0,
        "starts_on": budget.starts_on if budget else start,
        "used_minutes": used,
        "exceeded": bool(budget and used > budget.minute_limit),
    }


@router.put("/budget")
def put_budget(payload: BudgetIn, session: Session = Depends(get_session)):
    budget = session.scalar(select(EntertainmentBudget).where(
        EntertainmentBudget.period_type == payload.period_type,
        EntertainmentBudget.deleted_at.is_(None),
    ).order_by(EntertainmentBudget.starts_on.desc()).limit(1))
    if not budget:
        budget = EntertainmentBudget(**payload.model_dump()); session.add(budget)
    else:
        apply_changes(budget, payload.model_dump(), set(BudgetIn.model_fields))
    session.flush()
    return model_dict(budget)


@router.get("/{game_id}")
def get_game(game_id: str, session: Session = Depends(get_session)):
    return game_out(session, active_record(session, Game, game_id, "游戏"), True)


@router.patch("/{game_id}")
def update_game(game_id: str, payload: GameIn, session: Session = Depends(get_session)):
    game = active_record(session, Game, game_id, "游戏")
    apply_changes(game, payload.model_dump(), set(GameIn.model_fields)); session.flush()
    return game_out(session, game, True)


@router.delete("/{game_id}")
def delete_game(game_id: str, session: Session = Depends(get_session)):
    game = active_record(session, Game, game_id, "游戏")
    soft_delete(game); session.flush()
    return game_out(session, game)


@router.post("/{game_id}/plans", status_code=status.HTTP_201_CREATED)
def add_plan(game_id: str, payload: PlanIn, session: Session = Depends(get_session)):
    game = active_record(session, Game, game_id, "游戏")
    plan = GamePlan(id=new_id(), game_id=game_id, agenda_id="pending", planned_minutes=payload.planned_minutes)
    agenda = AgendaItem(
        title=f"游戏：{game.name}", plan_date=payload.plan_date,
        module="games", source_type="game_plan", source_id=plan.id,
        bucket="optional",
    )
    session.add(agenda); session.flush(); plan.agenda_id = agenda.id
    session.add(plan); session.flush()
    row = model_dict(plan); row.update(plan_date=agenda.plan_date, status=agenda.status)
    return row


@router.post("/{game_id}/sessions", status_code=status.HTTP_201_CREATED)
def add_session(game_id: str, payload: SessionIn, session: Session = Depends(get_session)):
    active_record(session, Game, game_id, "游戏")
    item = GameSession(game_id=game_id, **payload.model_dump())
    session.add(item); session.flush()
    return model_dict(item)
