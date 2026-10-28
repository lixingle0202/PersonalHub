from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .deps import get_session
from ..models import (
    AgendaItem, Consultation, DailyActivity, DailyHealthLog, DevIssue, DevMilestone, DevProject,
    LearningGoal, MealPlan, MediaContent, QuickNote,
)
from ..services.diet import meal_display_name
from ..schemas import AgendaOut, DailyActivityOut, QuickNoteOut


router = APIRouter(tags=["home"])


@router.get("/home")
def home_summary(date: date, session: Session = Depends(get_session)):
    agenda = session.scalars(select(AgendaItem).where(
        AgendaItem.plan_date == date,
        AgendaItem.deleted_at.is_(None),
        AgendaItem.status != "cancelled",
        AgendaItem.module != "games",
        or_(AgendaItem.source_type.is_(None), AgendaItem.source_type != "game_plan"),
    ).order_by(AgendaItem.sort_order, AgendaItem.start_time)).all()
    total = len(agenda)
    completed = sum(item.status == "completed" for item in agenda)
    daily_activities = session.scalars(select(DailyActivity).where(
        DailyActivity.activity_date == date, DailyActivity.deleted_at.is_(None),
    ).order_by(DailyActivity.created_at, DailyActivity.sort_order, DailyActivity.id)).all()
    overdue = session.scalar(select(func.count(AgendaItem.id)).where(
        AgendaItem.plan_date < date,
        AgendaItem.status == "pending",
        AgendaItem.deleted_at.is_(None),
        AgendaItem.module != "games",
        or_(AgendaItem.source_type.is_(None), AgendaItem.source_type != "game_plan"),
    )) or 0
    due_soon = session.scalar(select(func.count(AgendaItem.id)).where(
        AgendaItem.plan_date > date,
        AgendaItem.plan_date <= date + timedelta(days=3),
        AgendaItem.status == "pending",
        AgendaItem.deleted_at.is_(None),
        AgendaItem.module != "games",
        or_(AgendaItem.source_type.is_(None), AgendaItem.source_type != "game_plan"),
    )) or 0
    notes = session.scalars(select(QuickNote).where(
        QuickNote.deleted_at.is_(None), QuickNote.is_archived.is_(False)
    ).order_by(QuickNote.is_important.desc(), QuickNote.created_at.desc()).limit(8)).all()

    active_projects = session.scalar(select(func.count(DevProject.id)).where(
        DevProject.status == "active", DevProject.deleted_at.is_(None)
    )) or 0
    blockers = session.scalar(select(func.count(DevIssue.id)).where(
        DevIssue.is_blocking.is_(True), DevIssue.status != "resolved", DevIssue.deleted_at.is_(None)
    )) or 0
    milestone = session.scalar(select(DevMilestone).where(
        DevMilestone.is_completed.is_(False),
        DevMilestone.deleted_at.is_(None),
        DevMilestone.target_date.is_not(None),
    ).order_by(DevMilestone.target_date).limit(1))

    next_media = session.execute(select(MediaContent, AgendaItem).join(
        AgendaItem, MediaContent.agenda_id == AgendaItem.id
    ).where(
        MediaContent.stage != "published", MediaContent.deleted_at.is_(None),
        AgendaItem.status == "pending", AgendaItem.deleted_at.is_(None),
    ).order_by(AgendaItem.plan_date).limit(1)).first()
    open_consultations = session.scalar(select(func.count(Consultation.id)).where(
        Consultation.stage != "completed", Consultation.deleted_at.is_(None)
    )) or 0
    next_consulting = session.scalar(select(AgendaItem).where(
        AgendaItem.module == "consulting", AgendaItem.status == "pending",
        AgendaItem.deleted_at.is_(None),
    ).order_by(AgendaItem.plan_date).limit(1))
    learning_today = [item for item in agenda if item.module == "learning"]
    current_learning_goals = session.scalars(select(LearningGoal).where(
        LearningGoal.deleted_at.is_(None), LearningGoal.archived_at.is_(None),
        or_(LearningGoal.start_date.is_(None), LearningGoal.start_date <= date),
        or_(LearningGoal.target_date.is_(None), LearningGoal.target_date >= date),
    ).order_by(LearningGoal.updated_at.desc())).all()
    learning_goal_names = "、".join(goal.name for goal in current_learning_goals[:3])
    if len(current_learning_goals) > 3:
        learning_goal_names += f"等 {len(current_learning_goals)} 个目标"
    meals = session.scalars(select(MealPlan).where(
        MealPlan.meal_date == date, MealPlan.deleted_at.is_(None)
    ).order_by(MealPlan.meal_type)).all()
    next_meal = meals[0] if meals else None
    next_meal_name = ""
    if next_meal:
        next_meal_name = meal_display_name(session, next_meal)
    health = session.scalar(select(DailyHealthLog).where(
        DailyHealthLog.log_date == date, DailyHealthLog.deleted_at.is_(None)
    ))
    return {
        "date": date.isoformat(),
        "stats": {
            "total": total,
            "completed": completed,
            "completion_rate": round(completed * 100 / total) if total else 0,
            "must": sum(item.bucket == "must" and item.status == "pending" for item in agenda),
            "overdue": overdue,
            "due_soon": due_soon,
        },
        "agenda": [AgendaOut.model_validate(item) for item in agenda],
        "quick_notes": [QuickNoteOut.model_validate(note) for note in notes],
        "daily_activities": [DailyActivityOut.model_validate(item) for item in daily_activities],
        "summaries": {
            "media": {
                "title": f"下一条：{next_media[0].title}" if next_media else "暂无待发布内容",
                "count": 1 if next_media else 0,
                "detail": f"计划 {next_media[1].plan_date.isoformat()}" if next_media else "",
            },
            "development": {
                "title": f"{active_projects} 个进行中项目",
                "count": blockers,
                "detail": f"{blockers} 个阻塞问题" + (f"；最近里程碑 {milestone.name}" if milestone else ""),
            },
            "consulting": {
                "title": f"{open_consultations} 个进行中咨询" if open_consultations else "暂无待跟进咨询",
                "count": open_consultations,
                "detail": f"下次跟进 {next_consulting.plan_date.isoformat()}" if next_consulting else "",
            },
            "learning": {
                "title": f"当前目标：{learning_goal_names}" if current_learning_goals else (
                    f"今日 {len(learning_today)} 个学习任务" if learning_today else "暂无学习计划"
                ),
                "count": len(current_learning_goals) if current_learning_goals else len(learning_today),
                "detail": f"今日 {len(learning_today)} 个学习任务" if learning_today else "今日暂无学习任务",
            },
            "diet": {
                "title": f"下一餐：{next_meal_name}" if next_meal else "今日暂无饮食安排",
                "count": len(meals),
                "detail": f"已饮水 {health.water_ml if health else 0} ml",
            },
        },
    }
