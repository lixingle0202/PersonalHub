from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_linked_learning_and_diet_classification_survives_source_updates_completion_and_reload(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    with TestClient(app) as browser:
        browser.headers['x-local-token'] = app.state.local_token
        goal = browser.post('/api/v1/learning/goals', json={'name': '英语', 'goal': '练习口语'}).json()
        task = browser.post(f"/api/v1/learning/goals/{goal['id']}/tasks", json={
            'title': '口语练习', 'plan_date': '2026-11-04',
        }).json()
        meal = browser.post('/api/v1/diet/meals', json={
            'meal_date': '2026-11-04', 'meal_type': 'lunch', 'custom_name': '蛋炒饭200g',
        }).json()
        for source, bucket in [(task, 'must'), (meal, 'optional')]:
            agenda_id = source['agenda_id']
            previous = browser.get('/api/v1/agenda/' + agenda_id).json()
            changed = browser.patch('/api/v1/agenda/' + agenda_id, json={'bucket': bucket, 'priority': 'high'})
            assert changed.status_code == 200
            assert changed.json()['source_id'] == previous['source_id']
            assert changed.json()['bucket'] == bucket
            assert browser.patch('/api/v1/agenda/' + agenda_id, json={'bucket': 'invalid'}).status_code == 422
        updated_task = browser.patch(f"/api/v1/learning/tasks/{task['id']}", json={'title': '口语对话练习', 'plan_date': '2026-11-04'})
        assert updated_task.status_code == 200
        updated_meal = browser.patch('/api/v1/diet/meals/' + meal['id'], json={
            'meal_date': '2026-11-04', 'meal_type': 'dinner', 'custom_name': '米饭200g',
        })
        assert updated_meal.status_code == 200
        for agenda_id, bucket in [(task['agenda_id'], 'must'), (meal['agenda_id'], 'optional')]:
            assert browser.get('/api/v1/agenda/' + agenda_id).json()['bucket'] == bucket
            browser.post('/api/v1/agenda/' + agenda_id + '/complete')
            reopened = browser.post('/api/v1/agenda/' + agenda_id + '/reopen').json()
            assert reopened['bucket'] == bucket and reopened['priority'] == 'high'
        assert browser.get('/api/v1/home?date=2026-11-04').json()['stats']['must'] == 1
    app.state.database.dispose()
