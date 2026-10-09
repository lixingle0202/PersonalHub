"""Allow calorie overrides on dishes and individual meals."""
from alembic import op
import sqlalchemy as sa

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table in ("dishes", "meal_plans"):
        if inspector.has_table(table) and "estimated_kcal" not in {column["name"] for column in inspector.get_columns(table)}:
            op.add_column(table, sa.Column("estimated_kcal", sa.Integer()))


def downgrade() -> None:
    for table in ("meal_plans", "dishes"):
        if sa.inspect(op.get_bind()).has_table(table):
            op.drop_column(table, "estimated_kcal")
