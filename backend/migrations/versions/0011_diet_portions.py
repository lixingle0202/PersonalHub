"""Record consumed portions and the number of servings a recipe makes."""
from alembic import op
import sqlalchemy as sa

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for table, column in (("dishes", "recipe_servings"), ("meal_plans", "servings")):
        inspector = sa.inspect(op.get_bind())
        if inspector.has_table(table) and column not in {item["name"] for item in inspector.get_columns(table)}:
            op.add_column(table, sa.Column(column, sa.Float(), nullable=False, server_default="1"))


def downgrade() -> None:
    op.drop_column("meal_plans", "servings")
    op.drop_column("dishes", "recipe_servings")
