"""Exercise a running full desktop build using fresh, isolated test accounts."""
import argparse
from datetime import date
import json
import time
import uuid

import httpx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('url')
    parser.add_argument('--real-ai', action='store_true')
    parser.add_argument('--local-ollama', help='Also verify a selected external loopback Ollama service')
    parser.add_argument('--expected-version', help='Require the executable API to report this release version')
    args = parser.parse_args()
    browser = httpx.Client(base_url=args.url, trust_env=False, timeout=20)
    today = date.today().isoformat()
    suffix = uuid.uuid4().hex[:8]
    credentials = {'username': 'verify_' + suffix, 'password': uuid.uuid4().hex}
    def request(method, path, body=None):
        response = browser.request(method, '/api/v1' + path, json=body)
        assert response.is_success, (method, path, response.status_code, response.text[:800])
        return response.json()
    assert browser.get('/health').json()['mode'] == 'desktop'
    assert browser.get('/api/v1/bootstrap').status_code == 401
    for route in ['/', '/today', '/learning', '/diet', '/settings']:
        page = browser.get(route)
        assert page.status_code == 200 and 'PersonalHub' in page.text
    request('POST', '/public/register', credentials)
    bootstrap = request('GET', '/bootstrap')
    assert bootstrap['desktop_mode']
    if args.expected_version:
        assert bootstrap['version'] == args.expected_version, bootstrap['version']
    browser.headers['X-Local-Token'] = bootstrap['local_token']
    assert request('GET', '/desktop/ai/status')['ready']
    print('PASS: login-required pages, registration, and independent built-in Ollama', flush=True)

    initial_model = request('GET', '/desktop/ai/settings')
    assert initial_model['source'] == 'builtin'
    endpoint = args.local_ollama or initial_model['base_url']
    installed = request('POST', '/desktop/ai/models', {'base_url': endpoint})['models']
    assert installed
    choice = {'source': 'local', 'base_url': endpoint, 'model': installed[0]}
    assert request('PUT', '/desktop/ai/settings', choice) == choice
    assert request('GET', '/ai/ollama/settings')['model'] == choice['model']
    missing = browser.put('/api/v1/desktop/ai/settings', json={**choice, 'model': 'not-an-installed-model:missing'})
    assert missing.status_code == 422
    assert request('GET', '/desktop/ai/settings') == choice
    if not args.local_ollama:
        request('PUT', '/desktop/ai/settings', {'source': 'builtin'})
    print('PASS: installed model list, verified selection, and failed-switch preservation', flush=True)

    request('PATCH', '/settings', {'theme_mode': 'dark', 'nickname': '桌面验收'})
    assert request('GET', '/settings')['theme_mode'] == 'dark'
    note = request('POST', '/quick-notes', {'content': '桌面验收备忘'})
    request('PATCH', '/quick-notes/' + note['id'], {'content': '桌面验收修改备忘'})
    agenda = request('POST', '/agenda', {'title': '桌面验收计划', 'plan_date': today, 'bucket': 'must'})
    request('POST', f"/agenda/{agenda['id']}/complete")
    request('POST', f"/agenda/{agenda['id']}/reopen")
    request('PATCH', f"/agenda/{agenda['id']}", {'bucket': 'optional', 'title': '修改后的桌面验收计划'})
    assert any(item['id'] == agenda['id'] and item['status'] == 'pending' and item['bucket'] == 'optional'
               for item in request('GET', '/agenda?date=' + today))
    activities = request('POST', '/daily-activities/narrate', {'activity_date': today,
        'text': '上午学了英语，下午跑八百米，晚上打羽毛球', 'request_id': str(uuid.uuid4())})
    assert any('跑八百米' in item['content'] and item['category'] == 'exercise' for item in activities['items'])
    print('PASS: global dark mode, memo editing, today-plan CRUD, completion undo, daily classification', flush=True)

    goal = request('POST', '/learning/goals', {'name': '桌面验收目标'})
    section = request('POST', f"/learning/goals/{goal['id']}/sections", {'name': '自建阶段'})
    task = request('POST', f"/learning/goals/{goal['id']}/tasks", {'title': '阶段任务', 'plan_date': today})
    request('PATCH', f"/learning/tasks/{task['id']}", {'section_id': section['id'], 'estimated_minutes': 45})
    request('PATCH', f"/learning/sections/{section['id']}", {'name': '手动修改阶段'})
    assert request('GET', f"/learning/goals/{goal['id']}")['tasks'][0]['section_id'] == section['id']
    request('DELETE', f"/learning/goals/{goal['id']}")
    assert request('GET', '/trash')
    request('POST', f"/trash/learning_goal/{goal['id']}/restore")
    assert request('GET', f"/learning/goals/{goal['id']}")['tasks']
    print('PASS: learning stages, editing, grouped deletion and full restoration', flush=True)

    search_goal = request('POST', '/learning/goals', {'name': '英语对照验收'})
    for index, minutes in enumerate((30, 45)):
        request('POST', f"/learning/goals/{search_goal['id']}/tasks", {
            'title': f'英语对照任务{index + 1}', 'plan_date': today, 'estimated_minutes': minutes})
    search_detail = request('GET', f"/learning/goals/{search_goal['id']}")
    request('POST', f"/agenda/{search_detail['tasks'][0]['agenda_id']}/complete")
    request('POST', f"/learning/goals/{search_goal['id']}/sessions", {
        'studied_on': today, 'actual_minutes': 20, 'notes': '英语手动学习记录'})
    comparison = request('GET', '/search/assist?q=今天英语学习计划与实际对照&today=' + today)['comparison']
    assert comparison['planned_count'] == 2 and comparison['completed_count'] == 1
    assert comparison['completion_rate'] == 50 and comparison['planned_learning_minutes'] == 75
    assert comparison['manual_learning_minutes'] == 20 and comparison['focus_minutes'] is None
    exercise = request('GET', '/search/assist?q=今天的运动记录&today=' + today)
    assert any('跑八百米' in item['title'] for item in exercise['results'])
    print('PASS: natural-language date/category search, plan completion comparison, and separate actual-time evidence', flush=True)

    trends = request('GET', f'/learning/trends?today={today}&days=7&goal_id={search_goal["id"]}')
    assert trends['manual']['minutes'] == 20 and trends['manual']['current_streak'] == 1
    assert trends['tasks']['completion_rate'] == 50 and trends['tasks']['planned'] == 2
    assert trends['focus']['record_count'] == 0
    request('POST', '/learning/focus/start', {'goal_id': search_goal['id']})
    request('POST', '/learning/focus/stop', {})
    trends = request('GET', f'/learning/trends?today={today}&days=30&goal_id={search_goal["id"]}')
    assert len(trends['days']) == 30 and trends['focus']['record_count'] == 1
    assert trends['manual']['minutes'] == 20
    print('PASS: packaged learning trends, goal filtering, task completion, manual logs and separate finished focus timers', flush=True)

    refs = request('GET', '/diet/food-references?q=土豆&limit=5')
    assert refs
    greens = request('GET', '/diet/food-references?q=炒青菜')
    assert greens['recipe_count'] >= 250 and greens['items'][0]['name'] == '清炒青菜'
    greens_meal = request('POST', '/diet/calories/estimate', {'custom_name': '米饭200g 炒青菜', 'servings': 1})
    assert greens_meal['display_kcal'] > 260 and all(item['kcal'] is not None for item in greens_meal['calorie_items'])
    estimate = request('POST', '/diet/calories/estimate', {'custom_name': '蛋炒饭200g+西红柿炒鸡蛋', 'servings': 1})
    assert estimate['display_kcal'] > 0
    meal = request('POST', '/diet/meals', {'meal_date': today, 'meal_type': 'lunch',
        'custom_name': '米饭200g+西红柿炒鸡蛋', 'servings': 1})
    request('PATCH', f"/diet/meals/{meal['id']}", {'meal_date': today, 'meal_type': 'lunch',
        'custom_name': '蛋炒饭200g', 'servings': 1})
    shopping = request('POST', '/diet/shopping-lists/generate', {'name': '验收购物清单', 'start_date': today, 'end_date': today})
    request('DELETE', '/diet/shopping-lists/' + shopping['id'])
    request('GET', '/home?date=' + today)
    request('GET', '/search?q=桌面')
    backup = request('POST', '/backups')
    assert backup and request('GET', '/backups')
    print('PASS: food autocomplete, combined calories, diet editing, shopping deletion, search and backup', flush=True)

    if args.real_ai:
        def generate(path, requirements):
            started = time.monotonic()
            response = browser.post('/api/v1' + path, json=requirements, headers={'Prefer': 'respond-async'})
            assert response.status_code == 202, response.text
            job_id = response.json()['job_id']
            deadline = started + 360
            while time.monotonic() < deadline:
                job = request('GET', '/ai/shared/jobs/' + job_id)
                if job['state'] == 'completed':
                    print(f'PASS: real {"selected Ollama" if args.local_ollama else "built-in AI"} {path} ({time.monotonic() - started:.1f}s)', flush=True)
                    return job['result']
                assert job['state'] not in {'failed', 'cancelled'}, job
                time.sleep(1)
            raise AssertionError('Real AI generation timed out')
        draft = generate('/ai/learning/generate', {'topic': 'Python', 'objective': '读取CSV并将筛选结果写回新CSV',
            'current_level': '会Python基础', 'preferences': '只使用csv标准库', 'start_date': today, 'days': 2, 'daily_minutes': 45})
        imported = request('POST', f"/ai/learning/drafts/{draft['id']}/import", draft['plan'])
        assert len(imported['tasks']) == 2
        diet = generate('/ai/diet/generate', {'theme': '一日均衡三餐', 'days': 1, 'preferences': '常见家常菜，不要海鲜'})
        template = request('POST', '/diet/templates', diet['plan'])
        request('POST', f"/diet/templates/{template['id']}/import", {'start_date': today, 'days': 1})
        print('PASS: AI learning imported into daily plans; real AI menu saved and imported into calendar', flush=True)

    other = httpx.Client(base_url=args.url, trust_env=False, timeout=20)
    result = other.post('/api/v1/public/register', json={'username': 'other_' + suffix, 'password': uuid.uuid4().hex})
    assert result.status_code == 200
    assert other.get('/api/v1/learning/goals').json() == []
    assert other.get('/api/v1/desktop/ai/settings').json()['source'] == 'builtin'
    assert other.get(f"/api/v1/learning/goals/{goal['id']}").status_code == 404
    assert other.get('/api/v1/search/assist', params={'q': '英语对照验收'}).json()['total_count'] == 0
    request('POST', '/public/logout')
    assert browser.get('/api/v1/bootstrap').status_code == 401
    request('POST', '/public/login', credentials)
    assert request('GET', '/learning/goals')
    request('PUT', '/desktop/ai/settings', {'source': 'builtin'})
    assert request('GET', '/desktop/ai/settings')['source'] == 'builtin'
    print('PASS: account isolation, logout, login, and persisted data', flush=True)
    print('PASS: complete desktop verification', flush=True)
    browser.close()
    other.close()


if __name__ == '__main__':
    main()
