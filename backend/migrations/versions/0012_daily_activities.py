"""Keep dated daily activities and their original narration."""
from alembic import op

from app.models import DailyActivity

revision = '0012'
down_revision = '0011'
branch_labels = None
depends_on = None


def upgrade() -> None:
    DailyActivity.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade() -> None:
    DailyActivity.__table__.drop(bind=op.get_bind(), checkfirst=True)
