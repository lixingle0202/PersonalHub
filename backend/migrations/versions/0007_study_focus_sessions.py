"""Persist start/stop focus sessions for daily Pomodoro totals."""
from alembic import op
import sqlalchemy as sa

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("study_focus_sessions"):
        return
    op.create_table(
        "study_focus_sessions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("goal_id", sa.String(36), sa.ForeignKey("learning_goals.id", ondelete="CASCADE"), nullable=False),
        sa.Column("task_id", sa.String(36), sa.ForeignKey("learning_tasks.id", ondelete="SET NULL")),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_study_focus_sessions_goal_id", "study_focus_sessions", ["goal_id"])


def downgrade() -> None:
    op.drop_index("ix_study_focus_sessions_goal_id", table_name="study_focus_sessions")
    op.drop_table("study_focus_sessions")
