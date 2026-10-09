"""Keep AI and manually edited instructions on learning tasks."""
from alembic import op
import sqlalchemy as sa

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("learning_tasks"):
        return
    columns = {column["name"] for column in inspector.get_columns("learning_tasks")}
    if "details" not in columns:
        op.add_column("learning_tasks", sa.Column("details", sa.Text(), nullable=False, server_default=""))
    # Existing AI imports kept the instructions in the linked agenda note.
    connection = op.get_bind()
    rows = connection.execute(sa.text("""
        SELECT t.id, a.notes, g.name FROM learning_tasks t
        JOIN learning_goals g ON g.id = t.goal_id
        JOIN agenda_items a ON a.id = t.agenda_id
        WHERE t.details = '' AND a.notes IS NOT NULL
    """)).fetchall()
    for task_id, notes, goal_name in rows:
        lines = notes.splitlines()
        if lines and lines[0] == f"学习目标：{goal_name}":
            lines = lines[1:]
        if lines and lines[0].startswith("预计 ") and lines[0].endswith(" 分钟"):
            lines = lines[1:]
        detail = "\n".join(lines).strip()
        if detail:
            connection.execute(sa.text("UPDATE learning_tasks SET details = :details WHERE id = :id"), {"details": detail, "id": task_id})


def downgrade() -> None:
    op.drop_column("learning_tasks", "details")
