from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_goal_detail_fetches_task_agendas_in_one_query(tmp_path):
    from sqlalchemy import event
    app = create_app(Settings(data_root=tmp_path / 'batch-links'))
    with TestClient(app) as client:
        client.headers['x-local-token'] = app.state.local_token
        goal = client.post('/api/v1/learning/goals', json={'name': '练习计划'}).json()
        tasks = [client.post(f"/api/v1/learning/goals/{goal['id']}/tasks", json={
            'title': f'任务{index}', 'plan_date': '2026-11-06', 'estimated_minutes': index + 10,
        }).json() for index in range(8)]
        client.post(f"/api/v1/agenda/{tasks[0]['agenda_id']}/complete")
        queries = []
        def capture(connection, cursor, statement, parameters, context, executemany):
            if statement.lstrip().upper().startswith('SELECT') and 'agenda_items' in statement:
                queries.append(statement)
        with app.state.database.session() as session:
            engine = session.get_bind()
        event.listen(engine, 'before_cursor_execute', capture)
        try:
            detail = client.get(f"/api/v1/learning/goals/{goal['id']}").json()
        finally:
            event.remove(engine, 'before_cursor_execute', capture)
        assert len(queries) == 1
        saved = {task['id']: task for task in detail['tasks']}
        for index, task in enumerate(tasks):
            assert saved[task['id']]['agenda_id'] == task['agenda_id']
            assert saved[task['id']]['estimated_minutes'] == index + 10
            assert saved[task['id']]['status'] == ('completed' if index == 0 else 'pending')
    app.state.database.dispose()


def test_daily_learning_task_completion_and_detail_changes_sync_with_agenda(tmp_path):
    app = create_app(Settings(data_root=tmp_path / "learning-tasks"))
    with TestClient(app) as client:
        client.headers['x-local-token'] = app.state.local_token
        goal = client.post('/api/v1/learning/goals', json={'name': 'Python 入门'}).json()
        section = client.post(f"/api/v1/learning/goals/{goal['id']}/sections", json={'name': '基础阶段'}).json()
        task = client.post(f"/api/v1/learning/goals/{goal['id']}/tasks", json={
            'title': '变量练习', 'details': '先阅读示例，再完成三道题',
            'section_id': section['id'], 'plan_date': '2026-10-10', 'estimated_minutes': 45,
        }).json()
        assert task['estimated_minutes'] == 45
        agenda_id = task['agenda_id']
        assert client.post(f'/api/v1/agenda/{agenda_id}/complete').status_code == 200
        completed = client.get(f"/api/v1/learning/goals/{goal['id']}").json()['tasks'][0]
        assert completed['status'] == 'completed'
        reopened = client.post(f'/api/v1/agenda/{agenda_id}/reopen')
        assert reopened.status_code == 200
        assert reopened.json()['status'] == 'pending'
        assert reopened.json()['completed_at'] is None
        restored = client.get(f"/api/v1/learning/goals/{goal['id']}").json()['tasks'][0]
        assert restored['status'] == 'pending'
        changed = client.patch(f"/api/v1/learning/tasks/{task['id']}", json={
            'details': '独立完成五道题', 'estimated_minutes': 60,
        }).json()
        assert changed['status'] == 'pending'
        assert changed['details'] == '独立完成五道题'
        assert changed['estimated_minutes'] == 60
        agenda = client.get('/api/v1/agenda', params={'date': '2026-10-10'}).json()[0]
        assert agenda['id'] == agenda_id
        assert '预计 60 分钟' in agenda['notes']
        assert '独立完成五道题' in agenda['notes']
        assert '预计 45 分钟' not in agenda['notes']
    app.state.database.dispose()
