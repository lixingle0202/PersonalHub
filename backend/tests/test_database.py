from datetime import date

import pytest
from sqlalchemy import inspect, select
from sqlalchemy.exc import IntegrityError

from app.database import Database
from app.migrations import migrate_database
from app.models import AgendaItem, DevProject, DevTask


EXPECTED_TABLES = {
    "settings", "agenda_items", "quick_notes", "daily_reviews",
    "media_contents", "media_metrics", "dev_projects", "dev_requirements",
    "dev_tasks", "dev_issues", "dev_milestones", "dev_logs",
    "consultations", "consultation_stages", "consultation_communications",
    "consultation_followups", "learning_goals", "learning_sections",
    "learning_tasks", "study_sessions", "learning_resources", "dishes",
    "dish_ingredients", "meal_plans", "daily_health_logs", "shopping_lists",
    "shopping_items", "games", "game_plans", "game_sessions",
    "entertainment_budgets", "alembic_version",
}


@pytest.fixture
def database(tmp_path):
    path = tmp_path / "data" / "test.db"
    migrate_database(path)
    database = Database(path)
    yield database
    database.dispose()


def test_migration_creates_complete_schema(database):
    assert EXPECTED_TABLES == set(inspect(database.engine).get_table_names())


def test_migration_is_idempotent(tmp_path):
    path = tmp_path / "test.db"
    migrate_database(path)
    migrate_database(path)
    assert "agenda_items" in inspect(Database(path).engine).get_table_names()


def test_foreign_keys_are_enforced(database):
    with pytest.raises(IntegrityError):
        with database.session() as session:
            session.add(DevTask(project_id="missing", title="invalid"))


def test_source_cannot_create_duplicate_agenda_items(database):
    with pytest.raises(IntegrityError):
        with database.session() as session:
            session.add_all([
                AgendaItem(
                    title="first", plan_date=date(2026, 9, 30),
                    source_type="dev_task", source_id="source-1",
                ),
                AgendaItem(
                    title="duplicate", plan_date=date(2026, 9, 30),
                    source_type="dev_task", source_id="source-1",
                ),
            ])
            session.flush()

    with database.session() as session:
        assert session.scalars(select(AgendaItem)).all() == []


def test_failed_transaction_leaves_no_partial_project(database):
    with pytest.raises(IntegrityError):
        with database.session() as session:
            project = DevProject(name="temporary")
            session.add(project)
            session.flush()
            session.add(DevTask(project_id="missing", title="invalid"))

    with database.session() as session:
        assert session.scalars(select(DevProject)).all() == []
