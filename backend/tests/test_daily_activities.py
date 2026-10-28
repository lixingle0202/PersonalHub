from concurrent.futures import ThreadPoolExecutor
from datetime import date
import sqlite3
from uuid import uuid4

from alembic import command
from fastapi.testclient import TestClient
import pytest

from app.config import Settings
from app.database import Database
from app.main import create_app
from app.migrations import migrate_database, migration_config
from app.models import AgendaItem, DailyActivity
from app.public import create_public_app
from app.services.daily_activities import split_narration


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    with TestClient(app) as client:
        client.headers['x-local-token'] = app.state.local_token
        yield client
    app.state.database.dispose()


def narration(text='上午学了英语一小时，中午吃了牛肉面，下午跑步30分钟，晚上去超市买了牛奶。', **changes):
    return {'activity_date': '2026-10-28', 'text': text, 'request_id': str(uuid4()), **changes}


@pytest.mark.parametrize('text,expected', [
    ('我今天上午学了英语一小时，中午吃了牛肉面，然后下午跑步30分钟，晚上去超市买了牛奶。',
     [('上午学了英语一小时', 'learning'), ('中午吃了牛肉面', 'diet'), ('下午跑步30分钟', 'exercise'), ('晚上去超市买了牛奶', 'life')]),
    ('早上吃了鸡蛋，牛奶和面包；下午去了医院复诊。',
     [('早上吃了鸡蛋，牛奶和面包', 'diet'), ('下午去了医院复诊', 'health')]),
    ('复习了数学然后做了十道题，还跑步20分钟', [('复习了数学', 'learning'), ('做了十道题', 'learning'), ('跑步20分钟', 'exercise')]),
    ('上午学了英语中午吃了米饭下午跑步20分钟', [('上午学了英语', 'learning'), ('中午吃了米饭', 'diet'), ('下午跑步20分钟', 'exercise')]),
    ('修好了自行车', [('修好了自行车', 'other')]),
    ('跑步20分钟，没有感觉累', [('跑步20分钟，没有感觉累', 'exercise')]),
    ('上午跑步10分钟，晚上跑步10分钟', [('上午跑步10分钟', 'exercise'), ('晚上跑步10分钟', 'exercise')]),
    ('上午学了英语，和朋友散步半小时', [('上午学了英语', 'learning'), ('和朋友散步半小时', 'exercise')]),
    ('准备了午餐', [('准备了午餐', 'diet')]),
])
def test_spoken_description_preserves_words_quantities_and_activity_boundaries(text, expected):
    activities, skipped = split_narration(text)
    assert [(item.content, item.category) for item in activities] == expected
    assert skipped == []


def test_future_and_negative_clauses_do_not_become_completed_activities():
    activities, skipped = split_narration('上午学了英语。明天打算跑步然后吃饭。还没吃晚饭。')
    assert [item.content for item in activities] == ['上午学了英语']
    assert skipped == ['明天打算跑步然后吃饭', '还没吃晚饭']
    activities, skipped = split_narration('没去健身，但是散步20分钟')
    assert [item.content for item in activities] == ['散步20分钟']
    assert skipped == ['没去健身']


def test_narration_is_persisted_in_home_only_on_its_date_and_does_not_create_plans(client):
    payload = narration()
    result = client.post('/api/v1/daily-activities/narrate', json=payload)
    assert result.status_code == 201
    rows = result.json()['items']
    assert len(rows) == 4 and result.json()['created'] is True
    assert all(row['source_text'] == payload['text'] and row['activity_date'] == '2026-10-28' for row in rows)
    assert client.get('/api/v1/daily-activities?date=2026-10-28').json() == rows
    assert client.get('/api/v1/home?date=2026-10-28').json()['daily_activities'] == rows
    assert client.get('/api/v1/home?date=2026-10-27').json()['daily_activities'] == []
    assert client.get('/api/v1/agenda?date=2026-10-28').json() == []
    assert client.get('/api/v1/diet/meals?start_date=2026-10-28&end_date=2026-10-28').json() == []
    assert client.get('/api/v1/learning/goals').json() == []
    restarted = create_app(client.app.state.settings)
    try:
        with TestClient(restarted) as browser:
            assert len(browser.get('/api/v1/daily-activities?date=2026-10-28').json()) == 4
    finally:
        restarted.state.database.dispose()


def test_submissions_append_but_retries_do_not_duplicate_and_changed_request_conflicts(client):
    payload = narration('上午跑步20分钟')
    first = client.post('/api/v1/daily-activities/narrate', json=payload)
    retry = client.post('/api/v1/daily-activities/narrate', json=payload)
    assert retry.status_code == 200 and retry.json()['created'] is False
    assert retry.json()['items'][0]['id'] == first.json()['items'][0]['id']
    assert client.post('/api/v1/daily-activities/narrate', json={**payload, 'text': '晚上跑步10分钟'}).status_code == 409
    assert client.post('/api/v1/daily-activities/narrate', json={**payload, 'activity_date': '2026-10-27'}).status_code == 409
    assert client.post('/api/v1/daily-activities/narrate', json=narration('晚上跑步10分钟')).status_code == 201
    assert len(client.get('/api/v1/daily-activities?date=2026-10-28').json()) == 2


def test_simultaneous_retry_commits_only_one_batch(client):
    payload = narration('跑步20分钟')
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: client.post('/api/v1/daily-activities/narrate', json=payload), range(2)))
    assert sorted(response.status_code for response in responses) == [200, 201]
    assert responses[0].json()['items'][0]['id'] == responses[1].json()['items'][0]['id']
    assert len(client.get('/api/v1/daily-activities?date=2026-10-28').json()) == 1


def test_entries_can_be_corrected_moved_deleted_and_restored(client):
    payload = narration('跑步20分钟')
    row = client.post('/api/v1/daily-activities/narrate', json=payload).json()['items'][0]
    changed = client.patch(f"/api/v1/daily-activities/{row['id']}", json={
        'content': '和朋友散步半小时', 'category': 'exercise', 'activity_date': '2026-10-27',
    })
    assert changed.status_code == 200
    assert changed.json()['source_text'] == '跑步20分钟'
    assert client.get('/api/v1/daily-activities?date=2026-10-28').json() == []
    assert client.get('/api/v1/daily-activities?date=2026-10-27').json()[0]['content'] == '和朋友散步半小时'
    assert client.delete(f"/api/v1/daily-activities/{row['id']}").status_code == 200
    assert client.get('/api/v1/home?date=2026-10-27').json()['daily_activities'] == []
    assert client.patch(f"/api/v1/daily-activities/{row['id']}", json={
        'content': '修改已删除记录', 'category': 'other', 'activity_date': '2026-10-28',
    }).status_code == 404
    assert client.post('/api/v1/daily-activities/narrate', json=payload).json()['items'] == []
    assert client.post(f"/api/v1/trash/daily_activity/{row['id']}/restore").status_code == 200
    assert client.get('/api/v1/daily-activities?date=2026-10-27').json()[0]['content'] == '和朋友散步半小时'


@pytest.mark.parametrize('change', [{'text': ' '}, {'text': '字' * 5001}, {'activity_date': 'not-a-date'}, {'request_id': 'bad-id'}])
def test_invalid_narrations_do_not_write_records(client, change):
    assert client.post('/api/v1/daily-activities/narrate', json=narration(**change)).status_code == 422
    assert client.get('/api/v1/daily-activities?date=2026-10-28').json() == []


def test_future_only_description_returns_notice_without_creating_a_record(client):
    result = client.post('/api/v1/daily-activities/narrate', json=narration('明天打算跑步。还没写作业。'))
    assert result.status_code == 200
    assert result.json()['items'] == [] and len(result.json()['skipped']) == 2


def test_write_token_required(client):
    client.headers.pop('x-local-token')
    assert client.post('/api/v1/daily-activities/narrate', json=narration()).status_code == 403


def test_backup_restore_recovers_daily_records_and_their_original_description(client):
    payload = narration('上午跑步20分钟')
    row = client.post('/api/v1/daily-activities/narrate', json=payload).json()['items'][0]
    backup = client.post('/api/v1/backups').json()
    client.delete(f"/api/v1/daily-activities/{row['id']}")
    assert client.get('/api/v1/daily-activities?date=2026-10-28').json() == []
    assert client.post(f"/api/v1/backups/{backup['name']}/restore").status_code == 200
    restored = client.get('/api/v1/daily-activities?date=2026-10-28').json()
    assert [(item['id'], item['content'], item['source_text']) for item in restored] == [(row['id'], '上午跑步20分钟', payload['text'])]


def test_public_accounts_cannot_read_edit_or_delete_each_others_daily_records(tmp_path):
    app = create_public_app(tmp_path / 'public')
    try:
        with TestClient(app, base_url='https://diary.example.test') as alice, TestClient(app, base_url='https://diary.example.test') as bob:
            for browser, name in [(alice, 'alice'), (bob, 'bobby')]:
                assert browser.post('/api/v1/public/register', json={'username': name, 'password': 'test-long-password'}).status_code == 200
                browser.headers['x-local-token'] = browser.get('/api/v1/bootstrap').json()['local_token']
            row = alice.post('/api/v1/daily-activities/narrate', json=narration('跑步20分钟')).json()['items'][0]
            assert bob.get('/api/v1/daily-activities?date=2026-10-28').json() == []
            assert bob.get('/api/v1/home?date=2026-10-28').json()['daily_activities'] == []
            assert bob.patch(f"/api/v1/daily-activities/{row['id']}", json={
                'content': '越权修改', 'category': 'other', 'activity_date': '2026-10-28',
            }).status_code == 404
            assert bob.delete(f"/api/v1/daily-activities/{row['id']}").status_code == 404
            assert alice.get('/api/v1/daily-activities?date=2026-10-28').json()[0]['content'] == '跑步20分钟'
    finally:
        for user_app in app.user_apps.values():
            user_app.state.database.dispose()


def test_upgrade_from_previous_schema_preserves_plans_and_adds_diary(tmp_path):
    path = tmp_path / 'existing.db'
    command.upgrade(migration_config(path), '0011')
    db = Database(path)
    try:
        with db.session() as session:
            session.add(AgendaItem(id='keep', title='去医院', plan_date=date(2026, 10, 28)))
        DailyActivity.__table__.drop(db.engine, checkfirst=True)
    finally:
        db.dispose()
    migrate_database(path)
    migrate_database(path)
    with sqlite3.connect(path) as connection:
        assert connection.execute('SELECT title FROM agenda_items WHERE id=?', ('keep',)).fetchone() == ('去医院',)
        assert connection.execute('SELECT count(*) FROM daily_activities').fetchone() == (0,)
        assert connection.execute('SELECT version_num FROM alembic_version').fetchone() == ('0012',)
