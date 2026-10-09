from datetime import date
import sqlite3

import pytest
from alembic import command
from sqlalchemy import inspect, select
from sqlalchemy.exc import IntegrityError

from app.database import Database
from app.migrations import migrate_database, migration_config
from app.models import AgendaItem, DevProject, DevTask, Game, GamePlan


EXPECTED_TABLES = {
    "settings", "agenda_items", "quick_notes", "daily_reviews",
    "media_contents", "media_metrics", "dev_projects", "dev_requirements",
    "dev_tasks", "dev_issues", "dev_milestones", "dev_logs",
    "consultations", "consultation_stages", "consultation_communications",
    "consultation_followups", "learning_goals", "learning_sections",
    "learning_tasks", "study_sessions", "learning_resources", "dishes",
    "dish_ingredients", "meal_plans", "daily_health_logs", "shopping_lists",
    "shopping_items", "games", "game_plans", "game_sessions",
    "entertainment_budgets", "ai_learning_drafts", "learning_auto_extensions", "alembic_version",
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
    assert "progress_override" in {column["name"] for column in inspect(database.engine).get_columns("learning_goals")}


def test_migration_is_idempotent(tmp_path):
    path = tmp_path / "test.db"
    migrate_database(path)
    migrate_database(path)
    database = Database(path)
    try:
        assert "agenda_items" in inspect(database.engine).get_table_names()
        with database.engine.connect() as connection:
            assert connection.exec_driver_sql("SELECT version_num FROM alembic_version").scalar_one() == "0006"
    finally:
        database.dispose()


def test_migration_adds_manual_progress_to_an_existing_database(tmp_path):
    path = tmp_path / "existing.db"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL PRIMARY KEY)")
        connection.execute("INSERT INTO alembic_version (version_num) VALUES ('0001')")
        connection.execute("CREATE TABLE learning_goals (id VARCHAR(36) NOT NULL PRIMARY KEY)")

    migrate_database(path)

    database = Database(path)
    try:
        columns = {column["name"] for column in inspect(database.engine).get_columns("learning_goals")}
        assert "progress_override" in columns
        with database.engine.connect() as connection:
            assert connection.exec_driver_sql("SELECT version_num FROM alembic_version").scalar_one() == "0006"
    finally:
        database.dispose()


def test_migration_recovers_an_unversioned_database_without_losing_learning_goals(tmp_path):
    path = tmp_path / "unversioned.db"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL PRIMARY KEY)")
        connection.execute("""
            CREATE TABLE learning_goals (
                id VARCHAR(36) NOT NULL PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                goal TEXT NOT NULL,
                start_date DATE,
                target_date DATE,
                estimated_minutes INTEGER NOT NULL,
                archived_at DATETIME,
                deleted_at DATETIME,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )
        """)
        connection.execute("""
            INSERT INTO learning_goals (
                id, name, goal, estimated_minutes, created_at, updated_at
            ) VALUES (
                'legacy-goal', '安卓', '完成项目', 1200,
                '2026-09-30 08:00:00', '2026-09-30 08:00:00'
            )
        """)

    migrate_database(path)

    database = Database(path)
    try:
        columns = {column["name"] for column in inspect(database.engine).get_columns("learning_goals")}
        assert "progress_override" in columns
        with database.engine.connect() as connection:
            assert connection.exec_driver_sql("SELECT version_num FROM alembic_version").scalar_one() == "0006"
            assert connection.exec_driver_sql(
                "SELECT name FROM learning_goals WHERE id = 'legacy-goal'"
            ).scalar_one() == "安卓"
    finally:
        database.dispose()


def test_migration_retires_existing_game_plans_without_touching_other_agenda(tmp_path):
    path = tmp_path / "existing-games.db"
    command.upgrade(migration_config(path), "0002")
    database = Database(path)
    try:
        with database.session() as session:
            session.add(Game(id="game-1", name="示例游戏"))
            session.add_all([
                AgendaItem(
                    id="linked-game-agenda", title="历史关联计划", plan_date=date(2026, 10, 5),
                    module="general", source_type="legacy_reference", source_id="legacy-reference-1",
                ),
                AgendaItem(
                    id="module-game-agenda", title="游戏模块计划", plan_date=date(2026, 10, 5),
                    module="games",
                ),
                AgendaItem(
                    id="source-game-agenda", title="游戏来源计划", plan_date=date(2026, 10, 5),
                    module="general", source_type="game_plan", source_id="orphan-game-plan",
                ),
                AgendaItem(
                    id="learning-agenda", title="练习函数", plan_date=date(2026, 10, 5),
                    module="learning",
                ),
            ])
            session.add(GamePlan(
                id="game-plan-1", game_id="game-1", agenda_id="linked-game-agenda", planned_minutes=30,
            ))
    finally:
        database.dispose()

    migrate_database(path)

    database = Database(path)
    try:
        with database.session() as session:
            assert session.get(GamePlan, "game-plan-1").deleted_at is not None
            assert session.get(AgendaItem, "linked-game-agenda").deleted_at is not None
            assert session.get(AgendaItem, "module-game-agenda").deleted_at is not None
            assert session.get(AgendaItem, "source-game-agenda").deleted_at is not None
            assert session.get(AgendaItem, "learning-agenda").deleted_at is None
        with database.engine.connect() as connection:
            assert connection.exec_driver_sql("SELECT version_num FROM alembic_version").scalar_one() == "0006"
    finally:
        database.dispose()


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
