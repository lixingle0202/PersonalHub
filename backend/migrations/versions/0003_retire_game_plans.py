"""Retire game plans from active PersonalHub data.

Revision ID: 0003
Revises: 0002
"""
from alembic import op
import sqlalchemy as sa


revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())

    if "agenda_items" in tables:
        referenced_plan = ""
        if "game_plans" in tables:
            referenced_plan = "OR id IN (SELECT agenda_id FROM game_plans WHERE agenda_id IS NOT NULL)"
        bind.execute(sa.text(f"""
            UPDATE agenda_items
            SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE deleted_at IS NULL
              AND (
                module = 'games'
                OR source_type = 'game_plan'
                {referenced_plan}
              )
        """))

    if "game_plans" in tables:
        bind.execute(sa.text("""
            UPDATE game_plans
            SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE deleted_at IS NULL
        """))


def downgrade() -> None:
    # This cleanup is intentionally irreversible: automatically clearing
    # deleted_at could resurrect records the user deleted before this upgrade.
    pass
