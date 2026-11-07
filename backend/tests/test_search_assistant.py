from datetime import date, datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models import AgendaItem, DailyActivity, LearningGoal, LearningTask, QuickNote, StudyFocusSession, StudySession
from app.public import create_public_app
from app.services.search_assistant import parse_query


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    with TestClient(app) as browser:
        browser.headers['x-local-token'] = app.state.local_token
        yield browser
    app.state.database.dispose()


@pytest.mark.parametrize('query,expected', [
    ('找出上周没完成的英语任务', ('2026-10-26', '2026-11-01', 'all', 'pending', '英语', 'search')),
    ('查看昨天的运动记录', ('2026-11-06', '2026-11-06', 'exercise', 'all', '', 'search')),
    ('我这周原本打算学什么，实际完成了多少？', ('2026-11-02', '2026-11-08', 'learning', 'all', '', 'compare')),
    ('最近七天学习计划与实际对照', ('2026-11-01', '2026-11-07', 'learning', 'all', '', 'compare')),
    ('2026-11-01到2026-11-07学习对照', ('2026-11-01', '2026-11-07', 'learning', 'all', '', 'compare')),
    ('查看上个月已完成的任务', ('2026-10-01', '2026-10-31', 'all', 'completed', '', 'search')),
    ('Python', (None, None, 'all', 'all', 'Python', 'search')),
    ('学习“学习方法”的记录', (None, None, 'learning', 'all', '学习方法', 'search')),
])
def test_parse_time_category_status_and_literal_keyword(query, expected):
    parsed = parse_query(query, date(2026, 11, 7))
    assert (str(parsed.start_date) if parsed.start_date else None, str(parsed.end_date) if parsed.end_date else None,
            parsed.category, parsed.status, parsed.keyword, parsed.mode) == expected


def seed(app):
    with app.state.database.session() as session:
        goal = LearningGoal(id='g', name='英语', goal='口语练习')
        session.add(goal)
        for index, state, minutes, day in [(1, 'completed', 45, 3), (2, 'pending', None, 6), (3, 'pending', 30, 1)]:
            task = LearningTask(id=f't{index}', goal_id='g', title=f'口语练习{index}', details='复述文章')
            agenda = AgendaItem(id=f'a{index}', title=task.title, plan_date=date(2026, 11, day),
                                module='learning', source_type='learning_task', source_id=task.id,
                                status=state, notes=f'预计 {minutes} 分钟' if minutes else '')
            task.agenda_id = agenda.id
            session.add_all([task, agenda])
        session.add_all([
            StudySession(id='s', goal_id='g', studied_on=date(2026, 11, 3), actual_minutes=20, notes='英语复述'),
            StudyFocusSession(id='f', goal_id='g', task_id='t1',
                              started_at=datetime(2026, 11, 3, 8, 0, tzinfo=timezone.utc),
                              ended_at=datetime(2026, 11, 3, 8, 15, tzinfo=timezone.utc)),
            StudyFocusSession(id='running', goal_id='g', started_at=datetime(2026, 11, 3, 9, 0, tzinfo=timezone.utc)),
            DailyActivity(id='d', activity_date=date(2026, 11, 6), source_date=date(2026, 11, 6),
                          content='学习英语两小时', category='learning', source_text='学习英语两小时', batch_id='batch', sort_order=0),
        ])


def assist(client, q='这周英语学习计划与实际对照', **params):
    response = client.get('/api/v1/search/assist', params={'q': q, 'today': '2026-11-07', **params})
    assert response.status_code == 200, response.text
    return response.json()


def test_comparison_separates_evidence_and_unknown_values(client):
    seed(client.app)
    data = assist(client)
    summary = data['comparison']
    assert summary['planned_count'] == 2
    assert summary['completed_count'] == summary['pending_count'] == 1
    assert summary['completion_rate'] == 50
    assert summary['planned_learning_minutes'] == 45
    assert summary['missing_estimate_count'] == 1
    assert summary['manual_learning_minutes'] == 20
    assert summary['focus_minutes'] == 15
    assert summary['focus_record_count'] == 1  # Running timers are not final actual duration.
    assert summary['activity_count'] == 1
    assert 'actual_minutes' not in summary  # No fabricated combined manual/timer total.
    assert {item['type'] for item in summary['evidence']} == {'计划', '学习记录', '专注计时', '日常记录'}
    assert any('未来' in warning for warning in data['warnings'])


def test_missing_actual_is_null_even_when_activity_mentions_two_hours(client):
    seed(client.app)
    data = assist(client, '查看昨天学习对照')
    assert data['comparison']['activity_count'] == 1
    assert data['comparison']['manual_learning_minutes'] is None
    assert data['comparison']['focus_minutes'] is None
    assert data['comparison']['completed_count'] == 0
    assert data['comparison']['planned_learning_minutes'] is None


def test_status_filters_results_but_not_comparison_denominator(client):
    seed(client.app)
    data = assist(client, '这周没完成的英语任务')
    assert [(item['id'], item['status']) for item in data['results']] == [('a2', 'pending')]
    assert data['comparison']['planned_count'] == 2
    assert data['comparison']['completed_count'] == 1
    assert data['comparison']['manual_learning_minutes'] == 20


def test_calendar_boundaries_and_clipped_cross_midnight_focus(client):
    seed(client.app)
    with client.app.state.database.session() as session:
        session.add(StudyFocusSession(id='midnight', goal_id='g',
                                     started_at=datetime(2026, 11, 5, 15, 50, tzinfo=timezone.utc),
                                     ended_at=datetime(2026, 11, 5, 16, 20, tzinfo=timezone.utc)))
    data = assist(client, '昨天学习对照', offset_minutes=-480)
    assert data['comparison']['focus_minutes'] == 20


def test_notes_activities_literal_wildcards_and_soft_delete(client):
    with client.app.state.database.session() as session:
        session.add_all([
            QuickNote(id='note', content='QZX备忘_%', created_at=datetime(2026, 11, 5, 16, 30)),
            QuickNote(id='gone', content='QZX删除', deleted_at=datetime(2026, 11, 6)),
            DailyActivity(id='run', activity_date=date(2026, 11, 6), source_date=date(2026, 11, 6),
                          content='跑八百米QZX', category='exercise', source_text='跑八百米QZX', batch_id='b', sort_order=0),
        ])
    assert {item['id'] for item in assist(client, 'QZX')['results']} == {'note', 'run'}
    assert [item['id'] for item in assist(client, '查看昨天的运动记录')['results']] == ['run']
    assert [item['id'] for item in assist(client, '昨天备忘', offset_minutes=-480)['results']] == ['note']
    assert [item['id'] for item in assist(client, '“_%”')['results']] == ['note']
    assert [item['id'] for item in assist(client, '%')['results']] == ['note']
    legacy = client.get('/api/v1/search', params={'q': 'QZX'}).json()
    assert {item['id'] for item in legacy} == {'note', 'run'}


def test_deleted_goal_hides_tasks_and_actual_evidence(client):
    seed(client.app)
    with client.app.state.database.session() as session:
        session.get(LearningGoal, 'g').deleted_at = datetime(2026, 11, 7)
    data = assist(client)
    assert data['comparison']['planned_count'] == 0
    assert data['comparison']['manual_learning_minutes'] is None
    assert data['comparison']['focus_minutes'] is None
    # Independent narration stays independent; it is not owned by the deleted goal.
    assert data['comparison']['activity_count'] == 1


def test_editable_conditions_and_empty_comparison(client):
    seed(client.app)
    data = assist(client, '昨天运动', start_date='2026-11-02', end_date='2026-11-08',
                  category='learning', keyword='英语', status_filter='all', mode='compare')
    assert data['comparison']['planned_count'] == 2
    empty = assist(client, '不存在的科目', mode='compare')
    assert empty['comparison']['completion_rate'] is None
    assert empty['comparison']['manual_learning_minutes'] is None
    assert assist(client, '昨天学习', all_dates=True)['interpretation']['start_date'] is None


def test_display_limit_does_not_truncate_statistics(client):
    with client.app.state.database.session() as session:
        session.add_all([AgendaItem(title=f'批量任务{index}', plan_date=date(2026, 11, 6), module='general', status='completed' if index < 50 else 'pending') for index in range(105)])
    data = assist(client, '昨天计划与实际对照')
    assert data['total_count'] == data['comparison']['planned_count'] == 105
    assert data['comparison']['completed_count'] == 50
    assert len(data['results']) == len(data['comparison']['evidence']) == 100
    assert data['comparison']['evidence_count'] == 105


@pytest.mark.parametrize('params', [
    {'q': '   '},
    {'q': '2026-02-30学习'}, {'q': '最近999天学习'}, {'q': '学习', 'category': 'invalid'},
    {'q': '学习', 'start_date': '2026-12-01', 'end_date': '2026-11-01'},
    {'q': '学习', 'start_date': '2026-11-01'},
    {'q': '学习', 'start_date': '2024-01-01', 'end_date': '2026-11-01'},
])
def test_invalid_queries_are_rejected(client, params):
    assert client.get('/api/v1/search/assist', params=params).status_code == 422


def test_new_search_is_authenticated_and_account_scoped(tmp_path):
    app = create_public_app(tmp_path / 'shared')
    with TestClient(app, base_url='https://hub.example.test') as browser:
        assert browser.get('/api/v1/search/assist', params={'q': 'PRIVATE'}).status_code == 401
        for username in ('search_owner', 'search_other'):
            assert browser.post('/api/v1/public/register', json={'username': username, 'password': 'private-password-123'}).status_code == 200
            token = browser.get('/api/v1/bootstrap').json()['local_token']
            if username == 'search_owner':
                assert browser.post('/api/v1/quick-notes', json={'content': 'PRIVATE_SEARCH_QZX'}, headers={'x-local-token': token, 'origin': 'https://hub.example.test'}).status_code == 201
            rows = browser.get('/api/v1/search/assist', params={'q': 'PRIVATE_SEARCH_QZX'}).json()['results']
            assert bool(rows) == (username == 'search_owner')
            browser.post('/api/v1/public/logout', headers={'origin': 'https://hub.example.test'})
