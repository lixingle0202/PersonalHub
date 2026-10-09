"""Store editable recurring diet templates."""
from alembic import op
import sqlalchemy as sa

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("diet_templates"):
        return
    op.create_table(
        "diet_templates",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("cycle_days", sa.Integer(), nullable=False),
        sa.Column("meals_json", sa.Text(), nullable=False),
        sa.Column("archived_at", sa.DateTime(timezone=True)),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_diet_templates_archived_at", "diet_templates", ["archived_at"])
    op.create_index("ix_diet_templates_deleted_at", "diet_templates", ["deleted_at"])


def downgrade() -> None:
    op.drop_index("ix_diet_templates_deleted_at", table_name="diet_templates")
    op.drop_index("ix_diet_templates_archived_at", table_name="diet_templates")
    op.drop_table("diet_templates")
