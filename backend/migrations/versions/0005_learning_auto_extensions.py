"""Persist automatic learning-plan extensions and their reminders."""
from alembic import op
import sqlalchemy as sa

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("learning_auto_extensions"):
        return
    op.create_table(
        "learning_auto_extensions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("goal_id", sa.String(36), sa.ForeignKey("learning_goals.id", ondelete="CASCADE"), nullable=False),
        sa.Column("triggered_on", sa.Date(), nullable=False),
        sa.Column("shifted_days", sa.Integer(), nullable=False),
        sa.Column("previous_first_date", sa.Date(), nullable=False),
        sa.Column("new_first_date", sa.Date(), nullable=False),
        sa.Column("acknowledged_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("goal_id", "triggered_on", name="uq_learning_extension_day"),
    )
    op.create_index("ix_learning_auto_extensions_goal_id", "learning_auto_extensions", ["goal_id"])


def downgrade() -> None:
    op.drop_index("ix_learning_auto_extensions_goal_id", table_name="learning_auto_extensions")
    op.drop_table("learning_auto_extensions")
