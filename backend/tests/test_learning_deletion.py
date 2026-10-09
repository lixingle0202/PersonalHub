from datetime import date, datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import Settings
from app.main import create_app
from app.models import (
    AgendaItem, LearningGoal, LearningResource, LearningSection, LearningTask,
    StudySession,
)


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    with TestClient(app) as client:
        client.headers["x-local-token"] = app.state.local_token
        yield client
    app.state.database.dispose()


def post(client, endpoint, payload):
    response = client.post(f"/api/v1{endpoint}", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def goal(client, name="学习测试目标"):
    return post(client, "/learning/goals", {"name": name})


def task(client, goal_id, title="学习测试任务", **values):
    return post(client, f"/learning/goals/{goal_id}/tasks", {"title": title, **values})


def agenda(client, day="2026-10-08"):
    response = client.get("/api/v1/agenda", params={"date": day})
    assert response.status_code == 200
    return response.json()


def home(client, day="2026-10-08"):
    response = client.get("/api/v1/home", params={"date": day})
    assert response.status_code == 200
    return response.json()


def search(client, query):
    return client.get("/api/v1/search", params={"q": query}).json()


def test_goal_delete_hides_all_children_legacy_agendas_and_statistics_only_for_that_goal(client):
    removed = goal(client, "删除目标专用关键词")
    kept = goal(client, "保留目标")
    section = post(client, f"/learning/goals/{removed['id']}/sections", {"name": "删除目标章节"})
    child_section = post(client, f"/learning/goals/{removed['id']}/sections", {
        "name": "删除目标子章节", "parent_id": section["id"],
    })
    first = task(client, removed["id"], "删除目标第一个任务", section_id=section["id"], plan_date="2026-10-08")
    old_deleted = task(client, removed["id"], "删除目标旧版本残留任务", plan_date="2026-10-08")
    unscheduled = task(client, removed["id"], "删除目标未排期任务")
    past = task(client, removed["id"], "删除目标逾期任务", plan_date="2026-10-07")
    upcoming = task(client, removed["id"], "删除目标即将到期任务", plan_date="2026-10-10")
    studied = post(client, f"/learning/goals/{removed['id']}/sessions", {
        "studied_on": "2026-10-08", "actual_minutes": 25, "notes": "删除目标记录",
    })
    resource = post(client, f"/learning/goals/{removed['id']}/resources", {"name": "删除目标资料"})
    kept_task = task(client, kept["id"], "保留任务", plan_date="2026-10-08")
    meal = post(client, "/diet/meals", {"meal_date": "2026-10-08", "meal_type": "lunch", "custom_name": "保留午餐"})
    manual = post(client, "/agenda", {"title": "保留独立计划", "plan_date": "2026-10-08"})
    old_timestamp = datetime(2026, 1, 1, tzinfo=timezone.utc)
    with client.app.state.database.session() as session:
        # An old forward link and the canonical source row can coexist in legacy data.
        legacy = AgendaItem(title="删除目标旧正向计划", plan_date=date(2026, 10, 8), module="learning")
        session.add(legacy)
        session.flush()
        legacy_id = legacy.id
        session.get(LearningTask, first["id"]).agenda_id = legacy.id
        session.get(LearningTask, old_deleted["id"]).deleted_at = old_timestamp
    assert home(client)["stats"]["total"] == 6
    assert home(client)["stats"]["overdue"] == 1
    assert home(client)["stats"]["due_soon"] == 1
    assert search(client, "删除目标")

    response = client.delete(f"/api/v1/learning/goals/{removed['id']}")
    assert response.status_code == 200
    assert response.json()["deleted_at"]
    assert client.delete(f"/api/v1/learning/goals/{removed['id']}").status_code == 404
    assert client.get(f"/api/v1/learning/goals/{removed['id']}").status_code == 404
    assert [entry["id"] for entry in client.get("/api/v1/learning/goals").json()] == [kept["id"]]
    assert {entry["id"] for entry in agenda(client)} == {kept_task["agenda_id"], meal["agenda_id"], manual["id"]}
    summary = home(client)
    assert summary["stats"]["total"] == 3
    assert summary["stats"]["completed"] == 0
    assert summary["stats"]["overdue"] == 0
    assert summary["stats"]["due_soon"] == 0
    assert summary["summaries"]["learning"]["count"] == 1
    assert summary["summaries"]["learning"]["title"] == "当前目标：保留目标"
    assert summary["summaries"]["learning"]["detail"] == "今日 1 个学习任务"
    assert search(client, "删除目标") == []
    with client.app.state.database.session() as session:
        for model, record_ids in [
            (LearningGoal, [removed["id"]]),
            (LearningSection, [section["id"], child_section["id"]]),
            (LearningTask, [first["id"], old_deleted["id"], unscheduled["id"], past["id"], upcoming["id"]]),
            (StudySession, [studied["id"]]), (LearningResource, [resource["id"]]),
            (AgendaItem, [first["agenda_id"], old_deleted["agenda_id"], past["agenda_id"], upcoming["agenda_id"], legacy_id]),
        ]:
            assert all(session.get(model, record_id).deleted_at is not None for record_id in record_ids)
        assert session.get(LearningTask, old_deleted["id"]).deleted_at.replace(tzinfo=timezone.utc) == old_timestamp
        assert session.get(LearningTask, kept_task["id"]).deleted_at is None


def test_goal_edit_updates_summary_and_search_preserving_task_notes_and_allows_clearing_optional_fields(client):
    parent = goal(client, "修改前唯一主题")
    item = task(client, parent["id"], "保留任务内容", plan_date="2026-10-08")
    with client.app.state.database.session() as session:
        session.get(AgendaItem, item["agenda_id"]).notes += "\n预计 30 分钟\nAI 练习备注"
    response = client.patch(f"/api/v1/learning/goals/{parent['id']}", json={
        "name": "修改后的主题", "goal": None, "estimated_minutes": None,
        "start_date": None, "target_date": None,
    })
    assert response.status_code == 200, response.text
    updated = response.json()
    assert updated["name"] == "修改后的主题"
    assert updated["goal"] == ""
    assert updated["estimated_minutes"] == 0
    assert updated["start_date"] is None and updated["target_date"] is None
    assert home(client)["summaries"]["learning"]["title"] == "当前目标：修改后的主题"
    assert agenda(client)[0]["notes"] == "学习目标：修改后的主题\n预计 30 分钟\nAI 练习备注"
    assert search(client, "修改前唯一主题") == []
    assert len(search(client, "修改后的主题")) == 2


@pytest.mark.parametrize("name", [None, "", "   "])
def test_empty_goal_name_is_rejected_without_changing_saved_data(client, name):
    parent = goal(client, "保留主题")
    response = client.patch(f"/api/v1/learning/goals/{parent['id']}", json={"name": name})
    assert response.status_code == 422
    assert client.get(f"/api/v1/learning/goals/{parent['id']}").json()["name"] == "保留主题"


@pytest.mark.parametrize("broken_link", ["missing", "legacy", "foreign_goal", "foreign_meal"])
def test_task_delete_removes_all_own_agendas_but_preserves_other_sources(client, broken_link):
    removed_goal = goal(client, "任务删除目标")
    kept_goal = goal(client, "另一目标")
    removed = task(client, removed_goal["id"], "单删任务独有关键词", plan_date="2026-10-08")
    kept = task(client, kept_goal["id"], "另一目标任务", plan_date="2026-10-08")
    meal = post(client, "/diet/meals", {"meal_date": "2026-10-08", "meal_type": "dinner", "custom_name": "保留晚餐"})
    legacy_id = None
    with client.app.state.database.session() as session:
        item = session.get(LearningTask, removed["id"])
        if broken_link == "missing":
            item.agenda_id = None
        elif broken_link == "legacy":
            legacy = AgendaItem(title="单删任务独有关键词旧计划", plan_date=date(2026, 10, 8), module="learning")
            session.add(legacy)
            session.flush()
            legacy_id = legacy.id
            item.agenda_id = legacy.id
        elif broken_link == "foreign_goal":
            session.get(LearningTask, kept["id"]).agenda_id = None
            session.flush()
            item.agenda_id = kept["agenda_id"]
        else:
            item.agenda_id = meal["agenda_id"]
    response = client.delete(f"/api/v1/learning/tasks/{removed['id']}")
    assert response.status_code == 200
    assert client.delete(f"/api/v1/learning/tasks/{removed['id']}").status_code == 404
    assert client.patch(f"/api/v1/learning/tasks/{removed['id']}", json={"plan_date": "2026-10-09"}).status_code == 404
    assert client.get(f"/api/v1/learning/goals/{removed_goal['id']}").json()["tasks"] == []
    assert {entry["id"] for entry in agenda(client)} == {kept["agenda_id"], meal["agenda_id"]}
    assert home(client)["stats"]["total"] == 2
    assert search(client, "单删任务独有关键词") == []
    with client.app.state.database.session() as session:
        assert session.get(AgendaItem, removed["agenda_id"]).deleted_at is not None
        if legacy_id:
            assert session.get(AgendaItem, legacy_id).deleted_at is not None
        assert session.get(AgendaItem, kept["agenda_id"]).deleted_at is None
        assert session.get(AgendaItem, meal["agenda_id"]).deleted_at is None


def test_task_edit_moves_date_and_title_everywhere_without_losing_completion_or_ai_notes(client):
    parent = goal(client)
    item = task(client, parent["id"], "修改前唯一任务", plan_date="2026-10-08", priority="high")
    with client.app.state.database.session() as session:
        session.get(AgendaItem, item["agenda_id"]).notes = "AI 学习实践；预计 35 分钟"
    assert client.post(f"/api/v1/agenda/{item['agenda_id']}/complete").status_code == 200
    updated = client.patch(f"/api/v1/learning/tasks/{item['id']}", json={"title": "修改后的学习任务", "plan_date": "2026-10-12"})
    assert updated.status_code == 200
    assert updated.json()["plan_date"] == "2026-10-12"
    assert updated.json()["status"] == "completed"
    assert updated.json()["priority"] == "high"
    assert updated.json()["agenda_id"] == item["agenda_id"]
    assert agenda(client) == []
    moved = agenda(client, "2026-10-12")
    assert len(moved) == 1
    assert moved[0]["title"] == "修改后的学习任务"
    assert moved[0]["notes"] == "AI 学习实践；预计 35 分钟"
    assert home(client)["stats"]["total"] == 0
    assert home(client, "2026-10-12")["stats"]["completed"] == 1
    assert search(client, "修改前唯一任务") == []
    assert len(search(client, "修改后的学习任务")) == 1


def test_clearing_and_recreating_task_schedule_reuses_unique_agenda_and_hides_old_date(client):
    parent = goal(client)
    item = task(client, parent["id"], "清空排期任务", plan_date="2026-10-08")
    cleared = client.patch(f"/api/v1/learning/tasks/{item['id']}", json={"plan_date": None})
    assert cleared.status_code == 200
    assert all(cleared.json()[key] is None for key in ("plan_date", "status", "priority", "agenda_id"))
    detail = client.get(f"/api/v1/learning/goals/{parent['id']}").json()
    assert detail["tasks"][0]["plan_date"] is None
    assert agenda(client) == []
    assert home(client)["stats"]["total"] == 0
    assert search(client, "清空排期任务") == []
    assert client.patch(f"/api/v1/learning/tasks/{item['id']}", json={"title": "重新排期任务"}).status_code == 200
    for new_date in ["2026-10-09", "2026-10-10"]:
        response = client.patch(f"/api/v1/learning/tasks/{item['id']}", json={"plan_date": new_date})
        assert response.status_code == 200, response.text
        assert response.json()["agenda_id"] == item["agenda_id"]
        assert response.json()["plan_date"] == new_date
        assert response.json()["title"] == "重新排期任务"
        assert response.json()["status"] == "pending"
    assert agenda(client, "2026-10-09") == []
    assert len(agenda(client, "2026-10-10")) == 1
    with client.app.state.database.session() as session:
        rows = session.scalars(select(AgendaItem).where(AgendaItem.source_id == item["id"])).all()
        assert len(rows) == 1
        assert rows[0].deleted_at is None


def test_unscheduled_task_can_be_renamed_then_scheduled_without_affecting_other_tasks(client):
    parent = goal(client)
    item = task(client, parent["id"])
    kept = task(client, parent["id"], "同目标保留任务", plan_date="2026-10-08")
    renamed = client.patch(f"/api/v1/learning/tasks/{item['id']}", json={"title": "新增排期任务"})
    assert renamed.status_code == 200
    assert renamed.json()["plan_date"] is None
    assert len(agenda(client)) == 1
    scheduled = client.patch(f"/api/v1/learning/tasks/{item['id']}", json={"plan_date": "2026-10-08"})
    assert scheduled.status_code == 200
    assert scheduled.json()["plan_date"] == "2026-10-08"
    entries = agenda(client)
    assert len(entries) == 2
    assert next(entry for entry in entries if entry["source_id"] == kept["id"])["title"] == "同目标保留任务"
    assert next(entry for entry in entries if entry["source_id"] == item["id"])["notes"] == "学习目标：学习测试目标"


@pytest.mark.parametrize("payload", [{"title": ""}, {"title": "   "}, {"title": None}, {"plan_date": "invalid-date"}])
def test_invalid_task_edits_are_rejected_without_partial_changes(client, payload):
    parent = goal(client)
    item = task(client, parent["id"], "原任务", plan_date="2026-10-08")
    response = client.patch(f"/api/v1/learning/tasks/{item['id']}", json=payload)
    assert response.status_code == 422
    saved = client.get(f"/api/v1/learning/goals/{parent['id']}").json()["tasks"][0]
    assert saved["title"] == "原任务"
    assert saved["plan_date"] == "2026-10-08"
    assert agenda(client)[0]["title"] == "原任务"


def test_task_sections_must_be_active_and_belong_to_the_same_goal(client):
    first = goal(client, "目标一")
    second = goal(client, "目标二")
    own = post(client, f"/learning/goals/{first['id']}/sections", {"name": "自己的章节"})
    foreign = post(client, f"/learning/goals/{second['id']}/sections", {"name": "其他目标章节"})
    item = task(client, first["id"], "原任务", section_id=own["id"])
    assert client.post(f"/api/v1/learning/goals/{first['id']}/tasks", json={"title": "错误关联", "section_id": foreign["id"]}).status_code == 422
    assert client.patch(f"/api/v1/learning/tasks/{item['id']}", json={"section_id": ""}).status_code == 404
    response = client.patch(f"/api/v1/learning/tasks/{item['id']}", json={"title": "不能部分保存", "section_id": foreign["id"]})
    assert response.status_code == 422
    assert client.delete(f"/api/v1/learning/sections/{own['id']}").status_code == 200
    assert client.patch(f"/api/v1/learning/tasks/{item['id']}", json={"section_id": own["id"]}).status_code == 404
    assert client.post(f"/api/v1/learning/goals/{first['id']}/tasks", json={"title": "已删章节", "section_id": own["id"]}).status_code == 404
    assert client.patch(f"/api/v1/learning/tasks/{item['id']}", json={"section_id": None}).status_code == 200
    saved = client.get(f"/api/v1/learning/goals/{first['id']}").json()["tasks"][0]
    assert saved["title"] == "原任务"
    assert saved["section_id"] is None


def test_legacy_children_of_deleted_goal_cannot_be_modified_or_added(client):
    parent = goal(client)
    section = post(client, f"/learning/goals/{parent['id']}/sections", {"name": "章节"})
    item = task(client, parent["id"], "任务")
    studied = post(client, f"/learning/goals/{parent['id']}/sessions", {"studied_on": "2026-10-08", "actual_minutes": 20})
    resource = post(client, f"/learning/goals/{parent['id']}/resources", {"name": "资料"})
    with client.app.state.database.session() as session:
        session.get(LearningGoal, parent["id"]).deleted_at = datetime.now(timezone.utc)
    for endpoint, payload in [
        (f"tasks/{item['id']}", {"title": "不可修改", "plan_date": "2026-10-08"}),
        (f"sections/{section['id']}", {"name": "不可修改"}),
        (f"sessions/{studied['id']}", {"actual_minutes": 100}),
        (f"resources/{resource['id']}", {"name": "不可修改"}),
    ]:
        assert client.patch(f"/api/v1/learning/{endpoint}", json=payload).status_code == 404
    for resource_name, payload in [
        ("tasks", {"title": "不可新增"}), ("sections", {"name": "不可新增"}),
        ("sessions", {"studied_on": "2026-10-08", "actual_minutes": 10}), ("resources", {"name": "不可新增"}),
    ]:
        assert client.post(f"/api/v1/learning/goals/{parent['id']}/{resource_name}", json=payload).status_code == 404
    assert agenda(client) == []


def test_edit_repairs_legacy_forward_link_and_preserves_the_other_goal_agenda(client):
    parent = goal(client)
    other_parent = goal(client, "保留目标")
    item = task(client, parent["id"], "需要修复的任务", plan_date="2026-10-08")
    other = task(client, other_parent["id"], "保留任务", plan_date="2026-10-08")
    with client.app.state.database.session() as session:
        session.get(LearningTask, other["id"]).agenda_id = None
        session.flush()
        session.get(LearningTask, item["id"]).agenda_id = other["agenda_id"]
    detail = client.get(f"/api/v1/learning/goals/{parent['id']}").json()
    assert detail["tasks"][0]["agenda_id"] == item["agenda_id"]
    renamed = client.patch(f"/api/v1/learning/tasks/{item['id']}", json={"title": "修复后的任务"})
    assert renamed.status_code == 200
    assert renamed.json()["agenda_id"] == item["agenda_id"]
    assert next(entry for entry in agenda(client) if entry["id"] == other["agenda_id"])["title"] == "保留任务"
    response = client.patch(f"/api/v1/learning/tasks/{item['id']}", json={"title": "修复后的任务", "plan_date": "2026-10-09"})
    assert response.status_code == 200
    assert response.json()["agenda_id"] == item["agenda_id"]
    assert agenda(client)[0]["title"] == "保留任务"
    assert agenda(client, "2026-10-09")[0]["title"] == "修复后的任务"


@pytest.mark.parametrize("operation", [
    "goal_post", "goal_patch", "goal_delete", "section_post", "task_post", "task_patch",
    "task_delete", "session_post", "resource_post", "resource_patch",
])
def test_learning_write_is_committed_before_success_response_starts(client, operation):
    parent = goal(client, "提交前主题")
    item = task(client, parent["id"], "提交前任务", plan_date="2026-10-08")
    resource = post(client, f"/learning/goals/{parent['id']}/resources", {"name": "提交前资料"})
    app = client.app
    observed = []

    class ResponseProbe:
        async def __call__(self, scope, receive, send):
            async def observe_send(message):
                if message["type"] == "http.response.start":
                    # TestClient normally waits for dependency teardown. Inspect a second
                    # connection at the actual response boundary to catch post-response commits.
                    with app.state.database.session() as session:
                        saved_goal = session.get(LearningGoal, parent["id"])
                        saved_task = session.get(LearningTask, item["id"])
                        saved_agenda = session.get(AgendaItem, item["agenda_id"])
                        observed.append({
                            "status": message["status"], "goal_name": saved_goal.name,
                            "goal_deleted": saved_goal.deleted_at is not None,
                            "task_title": saved_task.title,
                            "task_deleted": saved_task.deleted_at is not None,
                            "agenda_title": saved_agenda.title,
                            "agenda_notes": saved_agenda.notes,
                            "agenda_date": saved_agenda.plan_date.isoformat(),
                            "agenda_deleted": saved_agenda.deleted_at is not None,
                        })
                        state = observed[-1]
                        if operation == "goal_post":
                            state["created_goal_exists"] = session.scalar(select(LearningGoal).where(
                                LearningGoal.name == "提交后新建主题"
                            )) is not None
                        elif operation == "section_post":
                            state["created_section_exists"] = session.scalar(select(LearningSection).where(
                                LearningSection.goal_id == parent["id"], LearningSection.name == "提交后新章节"
                            )) is not None
                        elif operation == "task_post":
                            created_task = session.scalar(select(LearningTask).where(
                                LearningTask.goal_id == parent["id"], LearningTask.title == "提交后新任务"
                            ))
                            state["created_task_exists"] = created_task is not None
                            created_agenda = session.get(AgendaItem, created_task.agenda_id) if created_task else None
                            state["created_task_agenda"] = created_agenda.plan_date.isoformat() if created_agenda else None
                        elif operation == "session_post":
                            state["created_session_exists"] = session.scalar(select(StudySession).where(
                                StudySession.goal_id == parent["id"], StudySession.notes == "提交后新记录"
                            )) is not None
                        elif operation == "resource_post":
                            state["created_resource_exists"] = session.scalar(select(LearningResource).where(
                                LearningResource.goal_id == parent["id"], LearningResource.name == "提交后新资料"
                            )) is not None
                        elif operation == "resource_patch":
                            state["resource_name"] = session.get(LearningResource, resource["id"]).name
                await send(message)

            await app(scope, receive, observe_send)

    with TestClient(ResponseProbe()) as probe:
        probe.headers["x-local-token"] = client.headers["x-local-token"]
        if operation == "goal_post":
            response = probe.post("/api/v1/learning/goals", json={"name": "提交后新建主题"})
        elif operation == "goal_patch":
            response = probe.patch(f"/api/v1/learning/goals/{parent['id']}", json={"name": "已提交新主题"})
        elif operation == "goal_delete":
            response = probe.delete(f"/api/v1/learning/goals/{parent['id']}")
        elif operation == "task_patch":
            response = probe.patch(f"/api/v1/learning/tasks/{item['id']}", json={"title": "已提交新任务", "plan_date": "2026-10-09"})
        elif operation == "task_delete":
            response = probe.delete(f"/api/v1/learning/tasks/{item['id']}")
        elif operation == "section_post":
            response = probe.post(f"/api/v1/learning/goals/{parent['id']}/sections", json={"name": "提交后新章节"})
        elif operation == "task_post":
            response = probe.post(f"/api/v1/learning/goals/{parent['id']}/tasks", json={"title": "提交后新任务", "plan_date": "2026-10-09"})
        elif operation == "session_post":
            response = probe.post(f"/api/v1/learning/goals/{parent['id']}/sessions", json={"studied_on": "2026-10-09", "actual_minutes": 30, "notes": "提交后新记录"})
        elif operation == "resource_post":
            response = probe.post(f"/api/v1/learning/goals/{parent['id']}/resources", json={"name": "提交后新资料"})
        else:
            response = probe.patch(f"/api/v1/learning/resources/{resource['id']}", json={"name": "已提交资料"})
    expected_status = 201 if operation.endswith("_post") else 200
    assert response.status_code == expected_status, response.text
    assert len(observed) == 1
    state = observed[0]
    assert state["status"] == expected_status
    if operation == "goal_post":
        assert state["created_goal_exists"] is True
    elif operation == "goal_patch":
        assert state["goal_name"] == "已提交新主题"
        assert state["agenda_notes"] == "学习目标：已提交新主题"
    elif operation == "goal_delete":
        assert state["goal_deleted"] is True
        assert state["task_deleted"] is True
        assert state["agenda_deleted"] is True
    elif operation == "task_patch":
        assert state["task_title"] == state["agenda_title"] == "已提交新任务"
        assert state["agenda_date"] == "2026-10-09"
    elif operation == "task_delete":
        assert state["goal_deleted"] is False
        assert state["task_deleted"] is True
        assert state["agenda_deleted"] is True
    elif operation == "section_post":
        assert state["created_section_exists"] is True
    elif operation == "task_post":
        assert state["created_task_exists"] is True
        assert state["created_task_agenda"] == "2026-10-09"
    elif operation == "session_post":
        assert state["created_session_exists"] is True
    elif operation == "resource_post":
        assert state["created_resource_exists"] is True
    else:
        assert state["resource_name"] == "已提交资料"
