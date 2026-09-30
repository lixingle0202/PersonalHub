from __future__ import annotations

from datetime import date, datetime, timezone
import uuid

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def new_id() -> str:
    return str(uuid.uuid4())


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False
    )


class LifecycleMixin(TimestampMixin):
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)


class Setting(Base):
    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value_json: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class AgendaItem(LifecycleMixin, Base):
    __tablename__ = "agenda_items"
    __table_args__ = (
        UniqueConstraint("source_type", "source_id", name="uq_agenda_source"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    plan_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    start_time: Mapped[str | None] = mapped_column(String(5))
    end_time: Mapped[str | None] = mapped_column(String(5))
    priority: Mapped[str] = mapped_column(String(20), default="normal", index=True)
    bucket: Mapped[str] = mapped_column(String(20), default="scheduled")
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    module: Mapped[str] = mapped_column(String(30), default="general", index=True)
    source_type: Mapped[str | None] = mapped_column(String(50), index=True)
    source_id: Mapped[str | None] = mapped_column(String(36), index=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class QuickNote(LifecycleMixin, Base):
    __tablename__ = "quick_notes"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    is_important: Mapped[bool] = mapped_column(Boolean, default=False)
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False)
    converted_type: Mapped[str | None] = mapped_column(String(50))
    converted_id: Mapped[str | None] = mapped_column(String(36))


class DailyReview(TimestampMixin, Base):
    __tablename__ = "daily_reviews"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    review_date: Mapped[date] = mapped_column(Date, unique=True, nullable=False)
    summary: Mapped[str] = mapped_column(Text, default="")


class MediaContent(LifecycleMixin, Base):
    __tablename__ = "media_contents"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    platform: Mapped[str] = mapped_column(String(100), default="")
    content_type: Mapped[str] = mapped_column(String(100), default="")
    stage: Mapped[str] = mapped_column(String(30), default="idea", index=True)
    outline: Mapped[str] = mapped_column(Text, default="")
    body: Mapped[str] = mapped_column(Text, default="")
    reference_links: Mapped[str] = mapped_column(Text, default="")
    publish_link: Mapped[str] = mapped_column(Text, default="")
    published_at: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str] = mapped_column(Text, default="")
    agenda_id: Mapped[str | None] = mapped_column(
        ForeignKey("agenda_items.id", ondelete="SET NULL"), unique=True
    )


class MediaMetric(TimestampMixin, Base):
    __tablename__ = "media_metrics"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    content_id: Mapped[str] = mapped_column(ForeignKey("media_contents.id", ondelete="CASCADE"), index=True)
    recorded_on: Mapped[date] = mapped_column(Date, nullable=False)
    views: Mapped[int] = mapped_column(Integer, default=0)
    likes: Mapped[int] = mapped_column(Integer, default=0)
    comments: Mapped[int] = mapped_column(Integer, default=0)
    favorites: Mapped[int] = mapped_column(Integer, default=0)


class DevProject(LifecycleMixin, Base):
    __tablename__ = "dev_projects"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    goal: Mapped[str] = mapped_column(Text, default="")
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(30), default="planned", index=True)
    start_date: Mapped[date | None] = mapped_column(Date)
    due_date: Mapped[date | None] = mapped_column(Date, index=True)


class DevRequirement(LifecycleMixin, Base):
    __tablename__ = "dev_requirements"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("dev_projects.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(30), default="todo")
    priority: Mapped[str] = mapped_column(String(20), default="normal")


class DevTask(LifecycleMixin, Base):
    __tablename__ = "dev_tasks"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("dev_projects.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    workflow_status: Mapped[str] = mapped_column(String(30), default="todo", index=True)
    agenda_id: Mapped[str | None] = mapped_column(ForeignKey("agenda_items.id", ondelete="SET NULL"), unique=True)


class DevIssue(LifecycleMixin, Base):
    __tablename__ = "dev_issues"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("dev_projects.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    issue_type: Mapped[str] = mapped_column(String(50), default="bug")
    severity: Mapped[str] = mapped_column(String(20), default="normal")
    is_blocking: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    status: Mapped[str] = mapped_column(String(30), default="open", index=True)
    resolution: Mapped[str] = mapped_column(Text, default="")


class DevMilestone(LifecycleMixin, Base):
    __tablename__ = "dev_milestones"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("dev_projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    target_date: Mapped[date | None] = mapped_column(Date, index=True)
    is_completed: Mapped[bool] = mapped_column(Boolean, default=False)


class DevLog(LifecycleMixin, Base):
    __tablename__ = "dev_logs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("dev_projects.id", ondelete="CASCADE"), index=True)
    log_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    completed_work: Mapped[str] = mapped_column(Text, default="")
    problems: Mapped[str] = mapped_column(Text, default="")
    decisions: Mapped[str] = mapped_column(Text, default="")


class Consultation(LifecycleMixin, Base):
    __tablename__ = "consultations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    client_name: Mapped[str] = mapped_column(String(100), default="")
    contact: Mapped[str] = mapped_column(String(200), default="")
    original_question: Mapped[str] = mapped_column(Text, default="")
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    stage: Mapped[str] = mapped_column(String(30), default="intake", index=True)
    background: Mapped[str] = mapped_column(Text, default="")
    goal: Mapped[str] = mapped_column(Text, default="")
    current_state: Mapped[str] = mapped_column(Text, default="")
    constraints: Mapped[str] = mapped_column(Text, default="")
    overall_advice: Mapped[str] = mapped_column(Text, default="")
    resources: Mapped[str] = mapped_column(Text, default="")
    notes: Mapped[str] = mapped_column(Text, default="")


class ConsultationStage(LifecycleMixin, Base):
    __tablename__ = "consultation_stages"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    consultation_id: Mapped[str] = mapped_column(ForeignKey("consultations.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    goal: Mapped[str] = mapped_column(Text, default="")
    steps: Mapped[str] = mapped_column(Text, default="")
    schedule: Mapped[str] = mapped_column(Text, default="")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class ConsultationCommunication(LifecycleMixin, Base):
    __tablename__ = "consultation_communications"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    consultation_id: Mapped[str] = mapped_column(ForeignKey("consultations.id", ondelete="CASCADE"), index=True)
    communicated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    content: Mapped[str] = mapped_column(Text, default="")
    feedback: Mapped[str] = mapped_column(Text, default="")
    changes: Mapped[str] = mapped_column(Text, default="")


class ConsultationFollowup(LifecycleMixin, Base):
    __tablename__ = "consultation_followups"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    consultation_id: Mapped[str] = mapped_column(ForeignKey("consultations.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    agenda_id: Mapped[str | None] = mapped_column(ForeignKey("agenda_items.id", ondelete="SET NULL"), unique=True)


class LearningGoal(LifecycleMixin, Base):
    __tablename__ = "learning_goals"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    goal: Mapped[str] = mapped_column(Text, default="")
    start_date: Mapped[date | None] = mapped_column(Date)
    target_date: Mapped[date | None] = mapped_column(Date)
    estimated_minutes: Mapped[int] = mapped_column(Integer, default=0)


class LearningSection(LifecycleMixin, Base):
    __tablename__ = "learning_sections"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    goal_id: Mapped[str] = mapped_column(ForeignKey("learning_goals.id", ondelete="CASCADE"), index=True)
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("learning_sections.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_completed: Mapped[bool] = mapped_column(Boolean, default=False)


class LearningTask(LifecycleMixin, Base):
    __tablename__ = "learning_tasks"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    goal_id: Mapped[str] = mapped_column(ForeignKey("learning_goals.id", ondelete="CASCADE"), index=True)
    section_id: Mapped[str | None] = mapped_column(ForeignKey("learning_sections.id", ondelete="SET NULL"), index=True)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    agenda_id: Mapped[str | None] = mapped_column(ForeignKey("agenda_items.id", ondelete="SET NULL"), unique=True)


class StudySession(LifecycleMixin, Base):
    __tablename__ = "study_sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    goal_id: Mapped[str] = mapped_column(ForeignKey("learning_goals.id", ondelete="CASCADE"), index=True)
    studied_on: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    actual_minutes: Mapped[int] = mapped_column(Integer, default=0)
    notes: Mapped[str] = mapped_column(Text, default="")
    problems: Mapped[str] = mapped_column(Text, default="")
    next_step: Mapped[str] = mapped_column(Text, default="")


class LearningResource(LifecycleMixin, Base):
    __tablename__ = "learning_resources"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    goal_id: Mapped[str] = mapped_column(ForeignKey("learning_goals.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    link: Mapped[str] = mapped_column(Text, default="")
    notes: Mapped[str] = mapped_column(Text, default="")


class Dish(LifecycleMixin, Base):
    __tablename__ = "dishes"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    instructions: Mapped[str] = mapped_column(Text, default="")
    nutrition_notes: Mapped[str] = mapped_column(Text, default="")
    notes: Mapped[str] = mapped_column(Text, default="")


class DishIngredient(TimestampMixin, Base):
    __tablename__ = "dish_ingredients"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    dish_id: Mapped[str] = mapped_column(ForeignKey("dishes.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    quantity: Mapped[float | None] = mapped_column(Float)
    unit: Mapped[str] = mapped_column(String(30), default="")


class MealPlan(LifecycleMixin, Base):
    __tablename__ = "meal_plans"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    meal_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    meal_type: Mapped[str] = mapped_column(String(20), nullable=False)
    dish_id: Mapped[str | None] = mapped_column(ForeignKey("dishes.id", ondelete="SET NULL"), index=True)
    custom_name: Mapped[str] = mapped_column(String(200), default="")
    actual_food: Mapped[str] = mapped_column(Text, default="")
    agenda_id: Mapped[str | None] = mapped_column(ForeignKey("agenda_items.id", ondelete="SET NULL"), unique=True)


class DailyHealthLog(LifecycleMixin, Base):
    __tablename__ = "daily_health_logs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    log_date: Mapped[date] = mapped_column(Date, unique=True, nullable=False)
    water_ml: Mapped[int] = mapped_column(Integer, default=0)
    weight_kg: Mapped[float | None] = mapped_column(Float)
    feeling: Mapped[str] = mapped_column(Text, default="")


class ShoppingList(LifecycleMixin, Base):
    __tablename__ = "shopping_lists"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)


class ShoppingItem(LifecycleMixin, Base):
    __tablename__ = "shopping_items"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    shopping_list_id: Mapped[str] = mapped_column(ForeignKey("shopping_lists.id", ondelete="CASCADE"), index=True)
    ingredient_name: Mapped[str] = mapped_column(String(200), nullable=False)
    quantity_text: Mapped[str] = mapped_column(String(100), default="")
    is_completed: Mapped[bool] = mapped_column(Boolean, default=False)
    is_manual: Mapped[bool] = mapped_column(Boolean, default=False)


class Game(LifecycleMixin, Base):
    __tablename__ = "games"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    platform: Mapped[str] = mapped_column(String(100), default="")
    genre: Mapped[str] = mapped_column(String(100), default="")
    status: Mapped[str] = mapped_column(String(30), default="wishlist", index=True)
    progress: Mapped[str] = mapped_column(Text, default="")
    next_goal: Mapped[str] = mapped_column(Text, default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    rating: Mapped[float | None] = mapped_column(Float)


class GamePlan(LifecycleMixin, Base):
    __tablename__ = "game_plans"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    game_id: Mapped[str] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"), index=True)
    agenda_id: Mapped[str] = mapped_column(ForeignKey("agenda_items.id", ondelete="CASCADE"), unique=True)
    planned_minutes: Mapped[int] = mapped_column(Integer, default=0)


class GameSession(LifecycleMixin, Base):
    __tablename__ = "game_sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    game_id: Mapped[str] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"), index=True)
    played_on: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    actual_minutes: Mapped[int] = mapped_column(Integer, default=0)
    notes: Mapped[str] = mapped_column(Text, default="")


class EntertainmentBudget(LifecycleMixin, Base):
    __tablename__ = "entertainment_budgets"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    period_type: Mapped[str] = mapped_column(String(20), nullable=False)
    minute_limit: Mapped[int] = mapped_column(Integer, nullable=False)
    starts_on: Mapped[date] = mapped_column(Date, nullable=False)
