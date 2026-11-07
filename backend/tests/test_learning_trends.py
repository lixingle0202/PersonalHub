from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models import AgendaItem, LearningGoal, LearningTask, StudyFocusSession, StudySession
from app.public import create_public_app


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    with TestClient(app) as browser:
        browser.headers['x-local-token'] = app.state.local_token
        yield browser
    app.state.database.dispose()


def trends(client, **params):
    response = client.get('/api/v1/learning/trends', params={'today': '2026-11-07', **params})
    assert response.status_code == 200, response.text
    return response.json()


def seed(client):
    with client.app.state.database.session() as session:
        session.add_all([LearningGoal(id='g1', name='英语'), LearningGoal(id='g2', name='编程')])


def test_empty_range_is_dense_missing_time_is_not_zero(client):
    data = trends(client)
    assert len(data['days']) == 7
    assert data['start_date'] == '2026-11-01'
    assert data['days'][-1] == {'date': '2026-11-07', 'manual_minutes': None, 'focus_seconds': None,
                                'planned_tasks': 0, 'completed_tasks': 0}
    assert data['tasks']['completion_rate'] is None
    assert data['manual']['current_streak'] == data['focus']['current_streak'] == 0


def test_manual_and_focus_remain_separate_and_split_local_midnight(client):
    seed(client)
    with client.app.state.database.session() as session:
        session.add_all([
            StudySession(goal_id='g1', studied_on=date(2026, 11, 6), actual_minutes=20),
            StudySession(goal_id='g1', studied_on=date(2026, 11, 6), actual_minutes=10),
            StudySession(goal_id='g1', studied_on=date(2026, 11, 7), actual_minutes=0),
            StudySession(goal_id='g1', studied_on=date(2026, 11, 8), actual_minutes=999),
            StudyFocusSession(goal_id='g1', started_at=datetime(2026, 11, 6, 15, 50),
                              ended_at=datetime(2026, 11, 6, 16, 20)),
            StudyFocusSession(goal_id='g1', started_at=datetime(2026, 11, 7, 1)),  # Still running.
            StudyFocusSession(goal_id='g1', started_at=datetime(2026, 11, 7, 2),
                              ended_at=datetime(2026, 11, 7, 1)),  # Invalid legacy interval.
        ])
    data = trends(client, offset_minutes=-480)
    assert data['manual'] == {'minutes': 30, 'record_count': 3, 'active_days': 1, 'current_streak': 1}
    assert data['focus'] == {'minutes': 30, 'record_count': 1, 'active_days': 2, 'current_streak': 2}
    assert data['days'][-2]['focus_seconds'] == 600
    assert data['days'][-1]['focus_seconds'] == 1200
    assert data['days'][-1]['manual_minutes'] == 0
    assert data['days'][0]['manual_minutes'] is None
    other_zone = trends(client, offset_minutes=0)
    assert other_zone['days'][-2]['focus_seconds'] == 1800
    assert other_zone['days'][-1]['focus_seconds'] is None


def test_streak_extends_beyond_range_and_breaks_after_missed_yesterday(client):
    seed(client)
    with client.app.state.database.session() as session:
        for index in range(10):
            session.add(StudySession(goal_id='g1', studied_on=date(2026, 11, 6) - timedelta(days=index), actual_minutes=1))
        # A timer ending at midnight must not mark the following day active.
        session.add(StudyFocusSession(goal_id='g1', started_at=datetime(2026, 11, 4, 23),
                                      ended_at=datetime(2026, 11, 6, 0)))
    data = trends(client)
    assert data['manual']['current_streak'] == 10
    assert data['manual']['active_days'] == 6
    assert data['focus']['current_streak'] == 0
    assert data['days'][-2]['focus_seconds'] is None
    assert trends(client, today='2026-11-08')['manual']['current_streak'] == 0


def test_task_trend_uses_current_status_by_plan_date_including_legacy_links(client):
    seed(client)
    with client.app.state.database.session() as session:
        session.add_all([
            AgendaItem(id='a1', title='背词', plan_date=date(2026, 11, 2), module='learning',
                       source_type='learning_task', source_id='t1', status='completed',
                       completed_at=datetime(2026, 11, 7, 10)),
            AgendaItem(id='a2', title='阅读', plan_date=date(2026, 11, 2), status='pending'),
            AgendaItem(id='cancel', title='取消任务', plan_date=date(2026, 11, 2), status='cancelled'),
            AgendaItem(id='diet', title='其他来源', plan_date=date(2026, 11, 2),
                       source_type='diet_meal', source_id='meal', status='completed'),
            LearningTask(id='t1', goal_id='g1', title='背词', agenda_id='a1'),
            LearningTask(id='t2', goal_id='g1', title='阅读', agenda_id='a2'),
            LearningTask(id='t3', goal_id='g1', title='取消任务', agenda_id='cancel'),
            LearningTask(id='t4', goal_id='g1', title='错误旧链接', agenda_id='diet'),
            LearningTask(id='t5', goal_id='g1', title='未排期'),
        ])
    data = trends(client)
    assert data['tasks'] == {'planned': 2, 'completed': 1, 'completion_rate': 50}
    assert data['days'][1]['completed_tasks'] == 1
    assert data['days'][-1]['completed_tasks'] == 0
    response = client.post('/api/v1/agenda/a2/complete', json={})
    assert response.status_code == 200
    assert trends(client)['tasks']['completion_rate'] == 100
    assert trends(client, goal_id='g2')['tasks']['planned'] == 0


def test_excludes_removed_goals_records_tasks_and_supports_goal_scope(client):
    seed(client)
    removed = datetime(2026, 11, 7, tzinfo=timezone.utc)
    with client.app.state.database.session() as session:
        session.add_all([
            LearningGoal(id='deleted', name='删除', deleted_at=removed),
            LearningGoal(id='archived', name='归档', archived_at=removed),
            StudySession(goal_id='g1', studied_on=date(2026, 11, 7), actual_minutes=10),
            StudySession(goal_id='g2', studied_on=date(2026, 11, 7), actual_minutes=20),
            StudySession(goal_id='deleted', studied_on=date(2026, 11, 7), actual_minutes=100),
            StudySession(goal_id='archived', studied_on=date(2026, 11, 7), actual_minutes=100),
            StudySession(goal_id='g1', studied_on=date(2026, 11, 7), actual_minutes=100, deleted_at=removed),
            LearningTask(id='removed-task', goal_id='g1', title='删除任务', deleted_at=removed),
            StudyFocusSession(goal_id='g1', task_id='removed-task', started_at=datetime(2026, 11, 7, 1),
                              ended_at=datetime(2026, 11, 7, 2)),
            StudyFocusSession(goal_id='deleted', started_at=datetime(2026, 11, 7, 1),
                              ended_at=datetime(2026, 11, 7, 2)),
        ])
    assert trends(client)['manual']['minutes'] == 30
    assert trends(client, goal_id='g1')['manual']['minutes'] == 10
    assert trends(client)['focus']['record_count'] == 0
    assert client.get('/api/v1/learning/trends', params={'today': '2026-11-07', 'goal_id': 'deleted'}).status_code == 404


def test_stale_forward_link_cannot_duplicate_another_goal_task(client):
    seed(client)
    with client.app.state.database.session() as session:
        session.add_all([
            AgendaItem(id='shared', title='正确任务', plan_date=date(2026, 11, 7), status='completed',
                       source_type='learning_task', source_id='right'),
            LearningTask(id='right', goal_id='g2', title='正确任务'),
            LearningTask(id='stale', goal_id='g1', title='旧链接', agenda_id='shared'),
        ])
    assert trends(client)['tasks']['planned'] == 1
    assert trends(client, goal_id='g1')['tasks']['planned'] == 0


@pytest.mark.parametrize('params', [{'days': 8}, {'days': 0}, {'days': 91}, {'offset_minutes': 9999},
                                   {'today': '2026-02-30'}, {'goal_id': 'unknown'}])
def test_rejects_invalid_parameters(client, params):
    response = client.get('/api/v1/learning/trends', params={'today': '2026-11-07', **params})
    assert response.status_code == (404 if 'goal_id' in params else 422)


@pytest.mark.parametrize('days', [7, 30, 90])
def test_supported_ranges(client, days):
    assert len(trends(client, days=days)['days']) == days


def test_authenticated_account_isolation(tmp_path):
    app = create_public_app(tmp_path / 'shared')
    with TestClient(app, base_url='https://hub.example.test') as browser:
        assert browser.get('/api/v1/learning/trends', params={'today': '2026-11-07'}).status_code == 401
        owner_goal = None
        for username in ('trends_owner', 'trends_other'):
            assert browser.post('/api/v1/public/register', json={'username': username, 'password': 'trend-test-password-123'}).status_code == 200
            token = browser.get('/api/v1/bootstrap').json()['local_token']
            headers = {'x-local-token': token, 'origin': 'https://hub.example.test'}
            if username == 'trends_owner':
                owner_goal = browser.post('/api/v1/learning/goals', json={'name': '个人目标'}, headers=headers).json()['id']
                assert browser.post(f'/api/v1/learning/goals/{owner_goal}/sessions', json={
                    'studied_on': '2026-11-07', 'actual_minutes': 35,
                }, headers=headers).status_code == 201
            assert trends(browser)['manual']['minutes'] == (35 if username == 'trends_owner' else 0)
            if username == 'trends_other':
                assert browser.get('/api/v1/learning/trends', params={'today': '2026-11-07', 'goal_id': owner_goal}).status_code == 404
            browser.post('/api/v1/public/logout', headers={'origin': 'https://hub.example.test'})
