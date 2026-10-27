from copy import deepcopy
import json

import httpx
import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.main import create_app
from app.migrations import migrate_database, migration_config
from app.database import Database
from app.models import AILearningDraft, AgendaItem, LearningGoal, QuickNote
from app.services import ollama

REAL_CLIENT = httpx.Client
CONFIG = {'base_url': 'http://127.0.0.1:11434', 'model': 'qwen2.5:3b'}
REQUIREMENTS = {'topic': 'Android', 'objective': '完成一个待办应用', 'start_date': '2026-12-31', 'days': 2, 'daily_minutes': 45}
MODEL_PLAN = {
    'name': 'Android 两天入门', 'goal': '理解界面与状态，完成练习', 'sections': ['界面', '状态'],
    'tasks': [
        {'day_number': 1, 'section_index': 0, 'title': '创建界面', 'minutes': 45, 'notes': '学习布局15分钟；练习按钮点击25分钟；产出：可运行的按钮界面；验收5分钟：点击按钮后文字改变。'},
        {'day_number': 2, 'section_index': 1, 'title': '保存状态', 'minutes': 45, 'notes': '学习状态保存15分钟；练习待办列表25分钟；产出：能保留输入的待办页；验收5分钟：重建页面后内容不丢失。'},
    ],
}


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    with TestClient(app, raise_server_exceptions=False) as client:
        client.headers['x-local-token'] = app.state.local_token
        yield client
    app.state.database.dispose()


def model_transport(monkeypatch, handler):
    def factory(**kwargs):
        assert kwargs['trust_env'] is False
        assert kwargs['follow_redirects'] is False
        return REAL_CLIENT(transport=httpx.MockTransport(handler), **kwargs)
    monkeypatch.setattr(ollama.httpx, 'Client', factory)


def generate_draft(client, monkeypatch, plan=None):
    assert client.put('/api/v1/ai/ollama/settings', json=CONFIG).status_code == 200
    model_transport(monkeypatch, lambda request: httpx.Response(200, json={'done': True, 'message': {'content': json.dumps(plan or MODEL_PLAN)}}))
    response = client.post('/api/v1/ai/learning/generate', json=REQUIREMENTS)
    assert response.status_code == 200, response.text
    return response.json()


def test_settings_defaults_and_persisted_local_configuration(client):
    assert client.get('/api/v1/ai/ollama/settings').json() == {'base_url': 'http://127.0.0.1:11434', 'model': ''}
    assert client.put('/api/v1/ai/ollama/settings', json=CONFIG).status_code == 200
    assert client.get('/api/v1/ai/ollama/settings').json() == CONFIG
    settings = client.app.state.settings
    restarted = create_app(settings)
    try:
        with TestClient(restarted) as other:
            assert other.get('/api/v1/ai/ollama/settings').json() == CONFIG
    finally:
        restarted.state.database.dispose()


@pytest.mark.parametrize('url', ['https://example.com', 'http://user:pass@localhost:11434', 'http://localhost:11434/path', 'http://localhost:99999'])
def test_local_provider_rejects_other_hosts_and_ambiguous_urls(client, url):
    assert client.put('/api/v1/ai/ollama/settings', json={**CONFIG, 'base_url': url}).status_code == 422
    assert client.post('/api/v1/ai/ollama/models', json={'base_url': url}).status_code == 422


def test_model_listing_uses_the_configured_local_endpoint(client, monkeypatch):
    def handler(request):
        assert str(request.url) == 'http://localhost:12345/api/tags'
        return httpx.Response(200, json={'models': [{'name': 'qwen2.5:3b'}, {'name': 'qwen2.5:3b'}, {'name': 'other'}]})
    model_transport(monkeypatch, handler)
    response = client.post('/api/v1/ai/ollama/models', json={'base_url': 'http://localhost:12345/'})
    assert response.json() == {'models': ['other', 'qwen2.5:3b']}


def test_generation_uses_structured_output_and_does_not_create_live_plans(client, monkeypatch):
    with client.app.state.database.session() as session:
        session.add(QuickNote(content='私人笔记：不要发送给模型'))
    client.put('/api/v1/ai/ollama/settings', json=CONFIG)
    def handler(request):
        body = json.loads(request.content)
        assert request.url.path == '/api/chat'
        assert body['model'] == CONFIG['model']
        assert body['stream'] is False and body['think'] is False
        assert body['format']['type'] == 'object'
        slots = body['format']['properties']['tasks']
        assert slots['minItems'] == slots['maxItems'] == 2
        assert [slot['properties']['day_number']['enum'] for slot in slots['prefixItems']] == [[1], [2]]
        assert [slot['properties']['section_index']['enum'] for slot in slots['prefixItems']] == [[0, 1], [0, 1]]
        assert body['format']['properties']['sections']['minItems'] == body['format']['properties']['sections']['maxItems'] == 2
        assert all(slot['properties']['minutes']['enum'] == [45] for slot in slots['prefixItems'])
        assert slots['items']['properties']['minutes']['enum'] == [45]
        assert {'steps', 'deliverable', 'verification'} <= set(slots['items']['required'])
        properties = list(slots['items']['properties'])
        assert properties.index('deliverable') < properties.index('steps')
        assert json.loads(body['messages'][1]['content'])['topic'] == 'Android'
        assert '私人笔记' not in json.dumps(body, ensure_ascii=False)
        return httpx.Response(200, json={'message': {'content': json.dumps(MODEL_PLAN)}})
    model_transport(monkeypatch, handler)
    draft = client.post('/api/v1/ai/learning/generate', json=REQUIREMENTS).json()
    assert [task['plan_date'] for task in draft['plan']['tasks']] == ['2026-12-31', '2027-01-01']
    assert client.get('/api/v1/learning/goals').json() == []
    assert client.get('/api/v1/agenda?date=2026-12-31').json() == []
    assert client.get(f"/api/v1/ai/learning/drafts/{draft['id']}").json() == draft


@pytest.mark.parametrize('days,minutes', [(1, 5), (7, 45), (30, 480)])
def test_small_model_generation_constrains_every_requested_day_and_its_time_budget(monkeypatch, days, minutes):
    calls = []
    def handler(request):
        body = json.loads(request.content)
        requirements = json.loads(body['messages'][1]['content'])
        batch_days = requirements['days']
        calls.append(requirements)
        sections = [f'阶段 {day}' for day in range(1, min(batch_days, 5) + 1)]
        slots = body['format']['properties']['tasks']
        assert batch_days <= 7
        assert slots['minItems'] == slots['maxItems'] == batch_days
        assert len(slots['prefixItems']) == batch_days
        assert [slot['properties']['day_number']['enum'][0] for slot in slots['prefixItems']] == list(range(1, batch_days + 1))
        assert all(slot['properties']['section_index']['enum'] == list(range(len(sections))) for slot in slots['prefixItems'])
        assert body['format']['properties']['sections']['maxItems'] == min(5, batch_days)
        assert body['format']['properties']['goal']['enum'] == [requirements['objective']]
        if batch_days == 1:
            assert body['format']['properties']['sections']['items']['enum'] == [requirements['objective'][:200]]
        assert all(slot['properties']['minutes']['enum'] == [minutes] for slot in slots['prefixItems'])
        assert len(body['messages'][0]['content']) < 1500  # Do not duplicate a 30-day schema into the prompt.
        result = {'name': '轻量模型计划', 'goal': '完成练习', 'sections': sections,
                  'tasks': [{'day_number': day, 'section_index': (day - 1) % len(sections),
                             'title': f"{requirements['start_date']}练习 {day}", 'minutes': minutes,
                             'notes': f'学习第{day}项状态知识并进行动手练习；产出：可运行的第{day}个页面；验收：独立复现页面行为并记录错误。'} for day in range(1, batch_days + 1)]}
        return httpx.Response(200, json={'message': {'content': json.dumps(result)}})
    model_transport(monkeypatch, handler)
    request = ollama.LearningGenerateRequest(**{**REQUIREMENTS, 'days': days, 'daily_minutes': minutes})
    result = ollama.generate_learning_plan(ollama.OllamaSettings(**CONFIG), request)
    assert len(result.tasks) == days
    assert all(task.minutes == minutes for task in result.tasks)
    assert len(calls) == (days + 6) // 7
    assert len({task.plan_date for task in result.tasks}) == days


@pytest.mark.parametrize('minutes,preference', [(45, '只使用csv模块，不使用pandas'), (60, '使用pandas处理缺失值并分组统计')])
def test_same_topic_uses_the_actual_requirements_and_full_daily_budget(monkeypatch, minutes, preference):
    def handler(request):
        body = json.loads(request.content)
        requirements = json.loads(body['messages'][1]['content'])
        assert requirements['preferences'] == preference
        assert preference in body['messages'][2]['content']
        assert f'每天{minutes}分钟' in body['messages'][2]['content']
        assert requirements['daily_minutes'] == minutes
        assert body['format']['properties']['tasks']['prefixItems'][0]['properties']['minutes']['enum'] == [minutes]
        assert '"minutes":30' not in body['messages'][0]['content']
        result = deepcopy(MODEL_PLAN)
        for task in result['tasks']:
            task['minutes'] = minutes
            task['notes'] = f"{preference}；学习具体API并完成第{task['day_number']}项练习；产出：运行代码和结果记录；验收：对照预期结果检查边界情况。"
        return httpx.Response(200, json={'message': {'content': json.dumps(result)}})
    model_transport(monkeypatch, handler)
    requirements = ollama.LearningGenerateRequest(**{**REQUIREMENTS, 'daily_minutes': minutes, 'preferences': preference})
    plan = ollama.generate_learning_plan(ollama.OllamaSettings(**CONFIG), requirements)
    assert all(task.minutes == minutes and preference in task.notes for task in plan.tasks)
    assert plan.goal == REQUIREMENTS['objective']


def test_vague_or_repeated_output_is_retried_once_with_feedback(monkeypatch):
    calls = []
    def handler(request):
        body = json.loads(request.content)
        calls.append(body)
        result = deepcopy(MODEL_PLAN)
        if len(calls) == 1:
            result['tasks'][0]['title'] = result['tasks'][1]['title'] = '考试准备'
        return httpx.Response(200, json={'message': {'content': json.dumps(result)}})
    model_transport(monkeypatch, handler)
    plan = ollama.generate_learning_plan(ollama.OllamaSettings(**CONFIG), ollama.LearningGenerateRequest(**REQUIREMENTS))
    assert len(calls) == 2
    assert '未通过校验' in calls[1]['messages'][1]['content']
    assert calls[1]['messages'][-2]['role'] == 'assistant'
    assert '纠正上一份JSON' in calls[1]['messages'][-1]['content']
    assert [task.title for task in plan.tasks] == ['创建界面', '保存状态']


def test_structured_activities_are_preserved_as_detailed_task_notes():
    result = deepcopy(MODEL_PLAN)
    result['tasks'][0]['title'] = '专项练习'
    for task in result['tasks']:
        task.update(notes='', steps=[{'minutes': 15, 'action': '阅读布局代码并标记控件'},
                                     {'minutes': 25, 'action': '实现按钮逻辑并运行页面'},
                                     {'minutes': 5, 'action': '运行输入为空的边界测试'}],
                    deliverable='提交可以运行的页面代码', verification='输入为空时提示错误，按钮可正常点击')
    plan = ollama.learning_preview_from_response(ollama.LearningGenerateRequest(**REQUIREMENTS),
                                                 {'message': {'content': json.dumps(result)}})
    assert all('15分钟：阅读布局代码' in task.notes and '产出：提交' in task.notes and '验收：输入为空' in task.notes for task in plan.tasks)
    assert plan.tasks[0].title == '运行输入为空的边界测试'
    result['tasks'][0]['steps'][0]['minutes'] = 30
    normalized = ollama.learning_preview_from_response(ollama.LearningGenerateRequest(**REQUIREMENTS),
                                                       {'message': {'content': json.dumps(result)}})
    assert normalized.tasks[0].minutes == 45
    assert normalized.tasks[0].notes.startswith('22分钟：阅读布局代码')
    assert '19分钟：实现按钮逻辑' in normalized.tasks[0].notes
    assert '4分钟：运行输入为空的边界测试' in normalized.tasks[0].notes


@pytest.mark.parametrize('bad_content', ['generic', 'wrong_chart'])
def test_requested_tool_in_goal_heading_does_not_hide_generic_daily_activities(monkeypatch, bad_content):
    requirements = ollama.LearningGenerateRequest(topic='Python', objective='用matplotlib绘制一张折线图',
        current_level='会列表', preferences='使用一周学习分钟，标注坐标并保存图片',
        start_date='2026-10-27', days=1, daily_minutes=60)
    calls = []
    def inference(_settings, _path, payload):
        calls.append(payload)
        task = {'day_number': 1, 'section_index': 0, 'title': '学习Python基础', 'minutes': 60,
                'steps': [{'minutes': 20, 'action': '阅读Python基础语法并运行简单例子'},
                          {'minutes': 40, 'action': '练习列表循环并输出三组数字'}],
                'deliverable': '提交能运行的练习代码', 'verification': '对照三组数字检查循环输出'}
        if bad_content == 'wrong_chart':
            task.update(title='绘制散点图',
                        steps=[{'minutes': 20, 'action': '阅读matplotlib文档学习散点图'},
                               {'minutes': 40, 'action': '运行散点图示例代码并检查图片'}])
        if len(calls) == 2:
            expected = 'matplotlib' if bad_content == 'generic' else '折线图'
            assert expected in json.loads(payload['messages'][1]['content'])['planning_context']
            task.update(title='绘制并保存一周学习分钟折线图',
                        steps=[{'minutes': 20, 'action': '用matplotlib绘制七天学习分钟折线图并标注横纵坐标'},
                               {'minutes': 40, 'action': '保存图片并核对七个数据点与原始分钟一致'}],
                        deliverable='保存标注坐标的学习时长折线图PNG', verification='核对七个数据点、坐标文字和保存的PNG图片')
        return {'message': {'content': json.dumps({'name': requirements.objective, 'goal': requirements.objective,
                                                  'sections': ['折线图绘制'], 'tasks': [task]})}}
    monkeypatch.setattr(ollama, 'ollama_request', inference)
    result = ollama.generate_learning_plan(ollama.OllamaSettings(**CONFIG), requirements)
    assert len(calls) == 2
    assert 'matplotlib' in result.tasks[0].notes and '七个数据点' in result.tasks[0].notes


def test_later_batches_cannot_repeat_previous_task_titles(monkeypatch):
    calls = []
    def inference(_settings, _path, payload):
        requirements = json.loads(payload['messages'][1]['content'])
        calls.append(requirements)
        tasks = [{'day_number': day, 'section_index': 0, 'title': f'实现界面控件{day}', 'minutes': 45,
                  'notes': f'学习第{day}个具体控件并运行代码；产出：第{day}个控件页面；验收：核对点击后的文字变化符合预期。'}
                 for day in range(1, requirements['days'] + 1)]
        return {'message': {'content': json.dumps({'name': '界面练习', 'goal': '完成练习',
                                                  'sections': ['界面'], 'tasks': tasks})}}
    monkeypatch.setattr(ollama, 'ollama_request', inference)
    with pytest.raises(Exception, match='重复了已安排的任务'):
        ollama.generate_learning_plan(ollama.OllamaSettings(**CONFIG),
            ollama.LearningGenerateRequest(**{**REQUIREMENTS, 'days': 8}))
    assert len(calls) == 3
    assert '重复了已安排' in calls[-1]['planning_context']


def test_goal_operations_must_be_in_activities_not_only_claimed_in_verification():
    request = ollama.LearningGenerateRequest(topic='Python', objective='读取CSV并计算每列总和',
        start_date='2026-10-27', days=1, daily_minutes=45)
    task = {'day_number': 1, 'section_index': 0, 'title': '准备CSV环境', 'minutes': 45,
            'steps': [{'minutes': 15, 'action': '复习Python列表和循环'},
                      {'minutes': 30, 'action': '准备CSV文件并检查Python环境'}],
            'deliverable': '准备好CSV文件与Python环境', 'verification': '读取CSV并计算每列总和正确'}
    response = {'message': {'content': json.dumps({'name': request.objective, 'goal': request.objective,
        'sections': ['CSV处理'], 'tasks': [task]})}}
    with pytest.raises(Exception, match='具体活动没有安排目标要求的“读取”'):
        ollama.learning_preview_from_response(request, response)


def test_standard_library_preference_rejects_third_party_steps():
    request = ollama.LearningGenerateRequest(topic='Python', objective='读取CSV并计算每列总和',
        preferences='只用标准库csv，用两行数据自测', start_date='2026-10-27', days=1, daily_minutes=45)
    task = {'day_number': 1, 'section_index': 0, 'title': '读取并计算CSV列总和', 'minutes': 45,
            'steps': [{'minutes': 20, 'action': '使用pandas读取CSV文件并打印两行数据'},
                      {'minutes': 25, 'action': '计算每列总和并与手工结果对比'}],
            'deliverable': '提交计算CSV列总和的脚本', 'verification': '两列总和与手工结果一致'}
    result = {'name': '2026-10-27', 'goal': request.objective, 'sections': ['CSV处理'], 'tasks': [task]}
    with pytest.raises(Exception, match='用户限制的工具：pandas'):
        ollama.learning_preview_from_response(request, {'message': {'content': json.dumps(result)}})
    task['steps'][0]['action'] = '使用csv.reader读取CSV文件并打印两行数据'
    plan = ollama.learning_preview_from_response(request, {'message': {'content': json.dumps(result)}})
    assert plan.name == 'Python学习计划'


@pytest.mark.parametrize('message', ['invalid-message', {'content': None}, {'content': 42}])
def test_malformed_model_message_keeps_validation_error_actionable(monkeypatch, message):
    calls = []
    def inference(*_args):
        calls.append(True)
        return {'message': message}
    monkeypatch.setattr(ollama, 'ollama_request', inference)
    with pytest.raises(Exception, match='未通过校验'):
        ollama.generate_learning_plan(ollama.OllamaSettings(**CONFIG), ollama.LearningGenerateRequest(**REQUIREMENTS))
    assert len(calls) == 2


@pytest.mark.parametrize('change', ['vague', 'under_budget', 'no_deliverable'])
def test_persistently_poor_plans_create_neither_drafts_nor_formal_goals(client, monkeypatch, change):
    plan = deepcopy(MODEL_PLAN)
    if change == 'vague': plan['tasks'][0]['title'] = '考试准备'
    if change == 'under_budget': plan['tasks'][0]['minutes'] = 30
    if change == 'no_deliverable': plan['tasks'][0]['notes'] = '阅读课本，学习有关知识，进行相关练习，复习昨天学到的内容，继续学习。'
    client.put('/api/v1/ai/ollama/settings', json=CONFIG)
    model_transport(monkeypatch, lambda request: httpx.Response(200, json={'message': {'content': json.dumps(plan)}}))
    response = client.post('/api/v1/ai/learning/generate', json=REQUIREMENTS)
    assert response.status_code == 502
    with client.app.state.database.session() as session:
        assert session.scalars(select(AILearningDraft)).all() == []
        assert session.scalars(select(LearningGoal)).all() == []


def test_user_edited_draft_is_imported_once_and_visible_in_home_today_and_search(client, monkeypatch):
    draft = generate_draft(client, monkeypatch)
    draft['plan']['name'] = '我的 Android 计划'
    draft['plan']['tasks'][0]['title'] = '手动修改的任务'
    draft['plan']['tasks'][0]['minutes'] = 35
    endpoint = f"/api/v1/ai/learning/drafts/{draft['id']}/import"
    imported = client.post(endpoint, json=draft['plan'])
    assert imported.status_code == 201
    goal = imported.json()
    assert goal['name'] == '我的 Android 计划'
    assert goal['estimated_minutes'] == 80
    assert [item['name'] for item in goal['sections']] == MODEL_PLAN['sections']
    assert len(goal['tasks']) == 2
    assert goal['tasks'][0]['details'] == MODEL_PLAN['tasks'][0]['notes']
    assert goal['tasks'][0]['estimated_minutes'] == 35
    assert client.post(endpoint, json=draft['plan']).json()['id'] == goal['id']
    assert len(client.get('/api/v1/learning/goals').json()) == 1
    today = client.get('/api/v1/agenda?date=2026-12-31').json()
    assert len(today) == 1 and today[0]['title'] == '手动修改的任务'
    assert '预计 35 分钟' in today[0]['notes']
    edited = client.patch(f"/api/v1/learning/tasks/{goal['tasks'][0]['id']}", json={'details': '改成三道练习'}).json()
    assert edited['details'] == '改成三道练习'
    assert edited['estimated_minutes'] == 35
    assert '预计 35 分钟' in client.get('/api/v1/agenda?date=2026-12-31').json()[0]['notes']
    home = client.get('/api/v1/home?date=2026-12-31').json()
    assert home['stats']['total'] == 1 and home['summaries']['learning']['count'] == 1
    assert client.get('/api/v1/search?q=手动修改的任务').json()
    assert client.get('/api/v1/search?q=我的 Android 计划').json()
    client.delete(f"/api/v1/learning/goals/{goal['id']}")
    assert client.post(endpoint, json=draft['plan']).status_code == 409


def test_import_accepts_a_draft_after_removing_a_chapter_and_its_tasks(client, monkeypatch):
    draft = generate_draft(client, monkeypatch)
    remaining = draft['plan']['tasks'][1]
    remaining['section_index'] = 0
    draft['plan']['sections'] = ['状态']
    draft['plan']['tasks'] = [remaining]
    imported = client.post(f"/api/v1/ai/learning/drafts/{draft['id']}/import", json=draft['plan'])
    assert imported.status_code == 201
    goal = imported.json()
    assert [section['name'] for section in goal['sections']] == ['状态']
    assert [task['title'] for task in goal['tasks']] == ['保存状态']
    assert client.delete(f"/api/v1/learning/sections/{goal['sections'][0]['id']}").status_code == 200
    refreshed = client.get(f"/api/v1/learning/goals/{goal['id']}").json()
    assert refreshed['sections'] == []
    assert [task['title'] for task in refreshed['tasks']] == ['保存状态']


@pytest.mark.parametrize('change', ['bad_section', 'missing_section', 'missing_day', 'over_budget', 'duplicate', 'blank_title'])
def test_invalid_model_results_are_rejected_without_any_draft_or_live_plan(client, monkeypatch, change):
    plan = deepcopy(MODEL_PLAN)
    if change == 'bad_section': plan['tasks'][0]['section_index'] = 99
    if change == 'missing_section': plan['sections'] = plan['sections'][:1]
    if change == 'missing_day': plan['tasks'] = plan['tasks'][:1]
    if change == 'over_budget': plan['tasks'][0]['minutes'] = 46
    if change == 'duplicate': plan['tasks'].append(deepcopy(plan['tasks'][0]))
    if change == 'blank_title': plan['tasks'][0]['title'] = '  '
    client.put('/api/v1/ai/ollama/settings', json=CONFIG)
    model_transport(monkeypatch, lambda request: httpx.Response(200, json={'message': {'content': json.dumps(plan)}}))
    assert client.post('/api/v1/ai/learning/generate', json=REQUIREMENTS).status_code == 502
    with client.app.state.database.session() as session:
        assert session.scalars(select(AILearningDraft)).all() == []
        assert session.scalars(select(LearningGoal)).all() == []


@pytest.mark.parametrize('failure,expected', [('offline', 503), ('timeout', 504), ('missing', 422), ('invalid_json', 502), ('redirect', 502)])
def test_provider_errors_are_actionable_and_create_no_live_plan(client, monkeypatch, failure, expected):
    client.put('/api/v1/ai/ollama/settings', json=CONFIG)
    def handler(request):
        if failure == 'offline': raise httpx.ConnectError('offline', request=request)
        if failure == 'timeout': raise httpx.ReadTimeout('timeout', request=request)
        if failure == 'missing': return httpx.Response(404)
        if failure == 'redirect': return httpx.Response(302, headers={'Location': 'https://example.com'})
        return httpx.Response(200, content='invalid')
    model_transport(monkeypatch, handler)
    response = client.post('/api/v1/ai/learning/generate', json=REQUIREMENTS)
    assert response.status_code == expected
    assert isinstance(response.json()['detail'], str)
    assert client.get('/api/v1/learning/goals').json() == []


def test_import_validation_and_transaction_failure_leave_no_partial_plan(client, monkeypatch):
    draft = generate_draft(client, monkeypatch)
    invalid = deepcopy(draft['plan'])
    invalid['tasks'][0]['plan_date'] = '2027-02-01'
    endpoint = f"/api/v1/ai/learning/drafts/{draft['id']}/import"
    assert client.post(endpoint, json=invalid).status_code == 422
    original_flush = Session.flush
    def fail_on_agenda(self, *args, **kwargs):
        if any(isinstance(item, AgendaItem) for item in self.new):
            raise RuntimeError('simulated persistence failure')
        return original_flush(self, *args, **kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(Session, 'flush', fail_on_agenda)
        assert client.post(endpoint, json=draft['plan']).status_code == 500
    assert client.get('/api/v1/learning/goals').json() == []
    assert client.get('/api/v1/agenda?date=2026-12-31').json() == []
    assert client.post(endpoint, json=draft['plan']).status_code == 201


def test_missing_config_and_write_token_do_not_generate_or_import(client):
    assert client.post('/api/v1/ai/learning/generate', json=REQUIREMENTS).status_code == 422
    assert client.post('/api/v1/ai/learning/drafts/missing/import', json={}).status_code == 422
    client.headers.pop('x-local-token')
    assert client.put('/api/v1/ai/ollama/settings', json=CONFIG).status_code == 403
    assert client.post('/api/v1/ai/learning/generate', json=REQUIREMENTS).status_code == 403


def test_upgrade_from_0003_preserves_existing_learning_goals_and_adds_drafts(tmp_path):
    path = tmp_path / 'existing.db'
    command.upgrade(migration_config(path), '0003')
    database = Database(path)
    with database.session() as session:
        session.add(LearningGoal(id='keep', name='保留的计划'))
    with database.engine.begin() as connection:
        connection.exec_driver_sql('DROP TABLE ai_learning_drafts')
    database.dispose()
    migrate_database(path)
    database = Database(path)
    try:
        with database.session() as session:
            assert session.get(LearningGoal, 'keep').name == '保留的计划'
            assert session.scalars(select(AILearningDraft)).all() == []
    finally:
        database.dispose()
