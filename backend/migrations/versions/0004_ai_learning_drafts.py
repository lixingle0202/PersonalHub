"""Persist local model drafts and prevent duplicate learning-plan imports."""
from alembic import op
import sqlalchemy as sa

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("ai_learning_drafts"):
        return
    op.create_table(
        "ai_learning_drafts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("plan_json", sa.Text(), nullable=False),
        sa.Column("imported_goal_id", sa.String(36), sa.ForeignKey("learning_goals.id", ondelete="SET NULL")),
        sa.Column("imported_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("ai_learning_drafts")
