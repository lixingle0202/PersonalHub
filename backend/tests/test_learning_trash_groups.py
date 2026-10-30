from datetime import date, datetime, timezone

import pytest
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app
from app.models import AgendaItem, LearningGoal, LearningSection, LearningTask
from app.public import create_public_app


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    with TestClient(app) as browser:
        browser.headers['x-local-token'] = app.state.local_token
        yield browser
    app.state.database.dispose()


def post(client, path, payload):
    response = client.post('/api/v1' + path, json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def make_plan(client, name='英语学习计划'):
    goal = post(client, '/learning/goals', {'name': name, 'goal': '阅读、练习并记录学习成果'})
    prefix = f"/learning/goals/{goal['id']}"
    section = post(client, prefix + '/sections', {'name': '阅读阶段'})
    child_section = post(client, prefix + '/sections', {'name': '阅读练习', 'parent_id': section['id']})
    first = post(client, prefix + '/tasks', {
        'title': '精读一篇文章', 'details': '标注生词，写出三句摘要', 'section_id': child_section['id'],
        'plan_date': '2026-12-01', 'estimated_minutes': 45,
    })
    second = post(client, prefix + '/tasks', {
        'title': '完成阅读练习', 'details': '完成十道题并订正', 'plan_date': '2026-12-02',
    })
    unscheduled = post(client, prefix + '/tasks', {'title': '整理错题'})
    studied = post(client, prefix + '/sessions', {
        'studied_on': '2026-12-01', 'actual_minutes': 45, 'notes': '完成精读和摘要',
    })
    resource = post(client, prefix + '/resources', {'name': '学习笔记', 'notes': '语法与词汇整理'})
    assert client.post(f"/api/v1/agenda/{first['agenda_id']}/complete").status_code == 200
    return goal, section, child_section, first, second, unscheduled, studied, resource


def trash(client):
    response = client.get('/api/v1/trash')
    assert response.status_code == 200, response.text
    return response.json()


def restore(client, item_type, item_id):
    return client.post(f'/api/v1/trash/{item_type}/{item_id}/restore')


def delete_plan(client, goal):
    assert client.delete(f"/api/v1/learning/goals/{goal['id']}").status_code == 200


def test_deleted_plan_is_one_group_with_task_details_and_other_modules_stay_flat(client):
    goal, *children = make_plan(client)
    note = post(client, '/quick-notes', {'content': '独立备忘'})
    client.delete(f"/api/v1/quick-notes/{note['id']}")
    # Already deleted individual entries from older releases still belong to their plan.
    with client.app.state.database.session() as session:
        session.get(LearningTask, children[4]['id']).deleted_at = datetime(2020, 1, 1, tzinfo=timezone.utc)
    delete_plan(client, goal)
    rows = trash(client)
    assert len(rows) == 2
    group = next(row for row in rows if row['type'] == 'learning_goal')
    assert group['id'] == goal['id'] and group['title'] == goal['name']
    assert group['goal_deleted'] is True
    assert {row['id'] for row in group['children']} == {row['id'] for row in children}
    entry = next(row for row in group['children'] if row['title'] == '精读一篇文章')
    assert entry['details'] == '标注生词，写出三句摘要'
    assert entry['plan_date'] == '2026-12-01' and entry['status'] == 'completed'
    assert next(row for row in rows if row['type'] == 'quick_note')['id'] == note['id']


def test_restoring_whole_plan_preserves_dates_completion_notes_and_unscheduled_tasks(client):
    goal, section, child_section, first, second, unscheduled, studied, resource = make_plan(client)
    other = post(client, '/learning/goals', {'name': '另一个被删除计划'})
    delete_plan(client, other)
    delete_plan(client, goal)
    assert restore(client, 'learning_goal', goal['id']).status_code == 200
    detail = client.get(f"/api/v1/learning/goals/{goal['id']}").json()
    assert {item['id'] for item in detail['tasks']} == {first['id'], second['id'], unscheduled['id']}
    assert {item['id'] for item in detail['sections']} == {section['id'], child_section['id']}
    assert detail['sessions'][0]['id'] == studied['id']
    assert detail['resources'][0]['id'] == resource['id']
    saved = next(item for item in detail['tasks'] if item['id'] == first['id'])
    assert saved['plan_date'] == '2026-12-01' and saved['status'] == 'completed'
    assert saved['details'] == first['details'] and saved['estimated_minutes'] == 45
    assert next(item for item in detail['tasks'] if item['id'] == unscheduled['id'])['plan_date'] is None
    agendas = client.get('/api/v1/agenda?date=2026-12-01').json()
    assert len(agendas) == 1 and agendas[0]['id'] == first['agenda_id']
    assert client.get('/api/v1/home?date=2026-12-01').json()['stats']['completed'] == 1
    assert [row['id'] for row in trash(client)] == [other['id']]
    assert restore(client, 'learning_goal', goal['id']).status_code == 404


def test_restore_one_task_recovers_only_its_dependencies_and_group_survives_reload(client):
    goal, section, child_section, first, second, *_ = make_plan(client)
    delete_plan(client, goal)
    assert restore(client, 'learning_task', first['id']).status_code == 200
    detail = client.get(f"/api/v1/learning/goals/{goal['id']}").json()
    assert [item['id'] for item in detail['tasks']] == [first['id']]
    assert {item['id'] for item in detail['sections']} == {section['id'], child_section['id']}
    assert detail['resources'] == detail['sessions'] == []
    group = trash(client)[0]
    assert group['id'] == goal['id'] and group['goal_deleted'] is False
    assert first['id'] not in {item['id'] for item in group['children']}
    assert second['id'] in {item['id'] for item in group['children']}
    # A partial restore cannot expose a delete operation that destroys the live plan.
    assert client.delete(f"/api/v1/trash/learning_goal/{goal['id']}").status_code == 404
    assert restore(client, 'learning_goal', goal['id']).status_code == 200
    assert len(client.get(f"/api/v1/learning/goals/{goal['id']}").json()['tasks']) == 3
    assert trash(client) == []


@pytest.mark.parametrize('item_type,index', [('learning_section', 2), ('study_session', 6), ('learning_resource', 7)])
def test_individual_entries_can_be_restored_without_restoring_other_tasks(client, item_type, index):
    plan = make_plan(client)
    delete_plan(client, plan[0])
    assert restore(client, item_type, plan[index]['id']).status_code == 200
    detail = client.get(f"/api/v1/learning/goals/{plan[0]['id']}").json()
    assert detail['tasks'] == []
    assert plan[index]['id'] not in {row['id'] for row in trash(client)[0]['children']}
    if item_type == 'learning_section':
        assert len(detail['sections']) == 2


@pytest.mark.parametrize('link', ['missing', 'legacy_duplicate', 'foreign_goal', 'foreign_meal'])
def test_task_restore_repairs_legacy_visibility_without_restoring_foreign_or_duplicate_agendas(client, link):
    goal, *_sections, first, second, _unscheduled, _studied, _resource = make_plan(client)
    other_goal = post(client, '/learning/goals', {'name': '其他计划'})
    other_task = post(client, f"/learning/goals/{other_goal['id']}/tasks", {
        'title': '不要恢复的其他任务', 'plan_date': '2026-12-01',
    })
    meal = post(client, '/diet/meals', {'meal_date': '2026-12-01', 'meal_type': 'lunch', 'custom_name': '午餐'})
    client.delete(f"/api/v1/learning/tasks/{other_task['id']}")
    client.delete(f"/api/v1/diet/meals/{meal['id']}")
    legacy_id = None
    with client.app.state.database.session() as session:
        task = session.get(LearningTask, first['id'])
        if link == 'missing':
            task.agenda_id = None
        elif link == 'legacy_duplicate':
            legacy = AgendaItem(title='旧版重复日程', plan_date=date(2026, 12, 1), module='learning')
            session.add(legacy)
            session.flush()
            legacy_id = legacy.id
            task.agenda_id = legacy.id
        elif link == 'foreign_goal':
            session.get(LearningTask, other_task['id']).agenda_id = None
            session.flush()
            task.agenda_id = other_task['agenda_id']
        else:
            # Free the forward FK; canonical source metadata still identifies the meal.
            from app.models import MealPlan
            session.get(MealPlan, meal['id']).agenda_id = None
            session.flush()
            task.agenda_id = meal['agenda_id']
    delete_plan(client, goal)
    assert restore(client, 'learning_task', first['id']).status_code == 200
    rows = client.get('/api/v1/agenda?date=2026-12-01').json()
    assert [row['id'] for row in rows] == [first['agenda_id']]
    with client.app.state.database.session() as session:
        assert session.get(AgendaItem, other_task['agenda_id']).deleted_at is not None
        assert session.get(AgendaItem, meal['agenda_id']).deleted_at is not None
        if legacy_id:
            assert session.get(AgendaItem, legacy_id).deleted_at is not None
    assert second['id'] in {row['id'] for row in next(row for row in trash(client) if row['id'] == goal['id'])['children']}


def test_reset_groups_each_plan_including_an_empty_goal_and_never_restores_unrelated_plan(client):
    first = make_plan(client)[0]
    empty = post(client, '/learning/goals', {'name': '还没有任务的计划'})
    assert client.post('/api/v1/learning/reset').status_code == 200
    groups = {row['id']: row for row in trash(client)}
    assert set(groups) == {first['id'], empty['id']}
    assert groups[empty['id']]['children'] == []
    assert restore(client, 'learning_goal', empty['id']).status_code == 200
    assert [row['id'] for row in trash(client)] == [first['id']]
    assert client.get(f"/api/v1/learning/goals/{first['id']}").status_code == 404


def test_purging_an_individual_task_and_whole_plan_removes_only_the_selected_content(client):
    goal, _section, _child, first, second, *_ = make_plan(client)
    other = make_plan(client, '保留计划')[0]
    delete_plan(client, goal)
    assert client.delete(f"/api/v1/trash/learning_task/{first['id']}").status_code == 204
    assert first['id'] not in {row['id'] for row in trash(client)[0]['children']}
    assert client.delete(f"/api/v1/trash/learning_goal/{goal['id']}").status_code == 204
    assert trash(client) == []
    assert client.get(f"/api/v1/learning/goals/{other['id']}").status_code == 200
    with client.app.state.database.session() as session:
        assert session.get(LearningTask, second['id']) is None
        assert session.get(AgendaItem, second['agenda_id']) is None


def test_grouped_trash_and_restore_are_isolated_between_public_accounts(tmp_path):
    public = create_public_app(tmp_path / 'public')
    with TestClient(public, base_url='https://hub.example.test') as alice, TestClient(public, base_url='https://hub.example.test') as bob:
        for browser, name in [(alice, 'alice'), (bob, 'bob')]:
            assert browser.post('/api/v1/public/register', json={'username': name, 'password': 'long-test-password'}).status_code == 200
            browser.headers['x-local-token'] = browser.get('/api/v1/bootstrap').json()['local_token']
        goal = make_plan(alice)[0]
        delete_plan(alice, goal)
        assert len(trash(alice)) == 1 and trash(bob) == []
        assert restore(bob, 'learning_goal', goal['id']).status_code == 404
        assert restore(alice, 'learning_goal', goal['id']).status_code == 200
        assert bob.get('/api/v1/learning/goals').json() == []


def test_restore_is_committed_before_success_response_starts(client):
    goal, _section, _child, first, *_ = make_plan(client)
    delete_plan(client, goal)
    observed = []

    class ResponseProbe:
        async def __call__(self, scope, receive, send):
            async def observe(message):
                if message['type'] == 'http.response.start':
                    with client.app.state.database.session() as session:
                        observed.append((session.get(LearningGoal, goal['id']).deleted_at,
                                         session.get(LearningTask, first['id']).deleted_at,
                                         session.get(AgendaItem, first['agenda_id']).deleted_at))
                await send(message)
            await client.app(scope, receive, observe)

    with TestClient(ResponseProbe()) as browser:
        browser.headers['x-local-token'] = client.headers['x-local-token']
        assert restore(browser, 'learning_goal', goal['id']).status_code == 200
    assert observed == [(None, None, None)]


def test_category_restore_recovers_all_learning_plans_but_keeps_diet_and_notes_deleted(client):
    first = make_plan(client)[0]
    second = make_plan(client, '另一整套计划')[0]
    delete_plan(client, first)
    delete_plan(client, second)
    dish = post(client, '/diet/dishes', {'name': '番茄炒蛋'})
    note = post(client, '/quick-notes', {'content': '继续保留在回收站'})
    client.delete(f"/api/v1/diet/dishes/{dish['id']}")
    client.delete(f"/api/v1/quick-notes/{note['id']}")
    response = client.post('/api/v1/trash/categories/learning/restore')
    assert response.status_code == 200
    assert response.json() == {'module': 'learning', 'restored_groups': 2}
    for goal in [first, second]:
        assert len(client.get(f"/api/v1/learning/goals/{goal['id']}").json()['tasks']) == 3
    assert {row['id'] for row in trash(client)} == {dish['id'], note['id']}
    assert client.post('/api/v1/trash/categories/learning/restore').status_code == 404
    assert client.post('/api/v1/trash/categories/unknown/restore').status_code == 404


def test_category_restore_rolls_back_all_groups_on_failure(client, monkeypatch):
    from app.services import trash as service
    first = make_plan(client)[0]
    second = make_plan(client, '恢复失败的计划')[0]
    delete_plan(client, first)
    delete_plan(client, second)
    real_restore = service.restore_trash
    calls = []

    def fail_second(session, item_type, item_id):
        calls.append(item_id)
        if len(calls) == 2:
            raise LookupError('内容已被其他窗口修改，请刷新后重试')
        return real_restore(session, item_type, item_id)

    monkeypatch.setattr(service, 'restore_trash', fail_second)
    assert client.post('/api/v1/trash/categories/learning/restore').status_code == 404
    assert len(trash(client)) == 2
    assert client.get('/api/v1/learning/goals').json() == []


def test_shopping_list_groups_survive_partial_restore_and_diet_category_restores_remaining(client):
    from app.models import ShoppingItem, ShoppingList
    shopping = post(client, '/diet/shopping-lists', {
        'name': '本月采购', 'start_date': '2026-12-01', 'end_date': '2026-12-31',
    })
    first = post(client, f"/diet/shopping-lists/{shopping['id']}/items", {'ingredient_name': '鸡蛋', 'quantity_text': '10个'})
    second = post(client, f"/diet/shopping-lists/{shopping['id']}/items", {'ingredient_name': '番茄', 'quantity_text': '2斤'})
    client.patch(f"/api/v1/diet/shopping-items/{first['id']}", json={'is_completed': True})
    # Historical deleted lists and items need no migration to gain grouping.
    with client.app.state.database.session() as session:
        for model, item_id in [(ShoppingList, shopping['id']), (ShoppingItem, first['id']), (ShoppingItem, second['id'])]:
            session.get(model, item_id).deleted_at = datetime.now(timezone.utc)
    group = trash(client)[0]
    assert group['type'] == 'shopping_list' and group['parent_deleted'] is True
    assert {row['id'] for row in group['children']} == {first['id'], second['id']}
    egg = next(row for row in group['children'] if row['id'] == first['id'])
    assert egg['details'] == '10个' and egg['status'] == 'completed'
    assert restore(client, 'shopping_item', first['id']).status_code == 200
    group = trash(client)[0]
    assert group['parent_deleted'] is False and len(group['children']) == 1
    assert client.delete(f"/api/v1/trash/shopping_list/{shopping['id']}").status_code == 404
    dish = post(client, '/diet/dishes', {'name': '待恢复菜品'})
    client.delete(f"/api/v1/diet/dishes/{dish['id']}")
    response = client.post('/api/v1/trash/categories/diet/restore')
    assert response.status_code == 200 and response.json()['restored_groups'] == 2
    assert trash(client) == []
    saved = client.get('/api/v1/diet/shopping-lists').json()[0]
    assert len(saved['items']) == 2
    assert next(row for row in saved['items'] if row['id'] == first['id'])['is_completed'] is True
