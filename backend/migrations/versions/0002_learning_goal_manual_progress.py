"""Add optional manual learning progress.

Revision ID: 0002
Revises: 0001
"""
from alembic import op
import sqlalchemy as sa


revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def has_column(table_name: str, column_name: str) -> bool:
    inspector = sa.inspect(op.get_bind())
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    if not has_column("learning_goals", "progress_override"):
        op.add_column("learning_goals", sa.Column("progress_override", sa.Integer(), nullable=True))


def downgrade() -> None:
    if has_column("learning_goals", "progress_override"):
        op.drop_column("learning_goals", "progress_override")
