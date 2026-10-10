"""Allow a meal to include several common dishes while retaining older meals."""
from alembic import op
import sqlalchemy as sa

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("meal_plan_dishes"):
        op.create_table(
            "meal_plan_dishes",
            sa.Column("meal_id", sa.String(36), sa.ForeignKey("meal_plans.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("dish_id", sa.String(36), sa.ForeignKey("dishes.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("position", sa.Integer(), nullable=False),
        )
    if "ix_meal_plan_dishes_dish_id" not in {index["name"] for index in sa.inspect(op.get_bind()).get_indexes("meal_plan_dishes")}:
        op.create_index("ix_meal_plan_dishes_dish_id", "meal_plan_dishes", ["dish_id"])
    if inspector.has_table("meal_plans"):
        op.execute(sa.text("""
            INSERT OR IGNORE INTO meal_plan_dishes (meal_id, dish_id, position)
            SELECT id, dish_id, 0 FROM meal_plans WHERE dish_id IS NOT NULL
        """))


def downgrade() -> None:
    op.drop_index("ix_meal_plan_dishes_dish_id", table_name="meal_plan_dishes")
    op.drop_table("meal_plan_dishes")
