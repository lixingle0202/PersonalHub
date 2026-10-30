"""Optional live Ollama acceptance check; uses a fresh, isolated public account DB."""
import json
from pathlib import Path
import sys
import time

from fastapi.testclient import TestClient

from app.public import create_public_app
from app.services import ollama, shared_jobs


root = Path(__file__).resolve().parents[1]
artifacts = Path(sys.argv[1]).resolve()
if not artifacts.is_relative_to(root / '.test-runtime') or artifacts.exists():
    raise SystemExit('Choose a fresh directory inside .test-runtime')
artifacts.mkdir(parents=True)
shared_jobs.MAX_JOB_SECONDS = 180
original_request = ollama.ollama_request
attempts = []


def capture_request(settings, endpoint, payload=None):
    result = original_request(settings, endpoint, payload)
    attempts.append(result)
    (artifacts / 'model-attempts.json').write_text(json.dumps(attempts, ensure_ascii=False, indent=2), encoding='utf-8')
    return result


ollama.ollama_request = capture_request
app = create_public_app(artifacts / 'public-data')
requirements = {
    'topic': '高频电子线路', 'objective': '理解LC谐振频率与调幅包络，能够完成一个频率计算例题并辨认过调制波形',
    'current_level': '已学过基础电路分析', 'preferences': '不编程。两天分别练习LC谐振计算和调幅波形辨析，不重复阅读和记笔记。',
    'start_date': '2026-12-01', 'days': 2, 'daily_minutes': 45,
}
started = time.monotonic()
with TestClient(app, base_url='https://live-model.example.test') as browser:
    registered = browser.post('/api/v1/public/register', json={'username': 'livecheck', 'password': 'isolated-test-password'})
    registered.raise_for_status()
    browser.headers['x-local-token'] = browser.get('/api/v1/bootstrap').json()['local_token']
    response = browser.post('/api/v1/ai/learning/generate', json=requirements, headers={'Prefer': 'respond-async'})
    response.raise_for_status()
    assert response.status_code == 202
    job_id = response.json()['job_id']
    print(json.dumps({'accepted_seconds': round(time.monotonic() - started, 2), 'job': 'accepted'}), flush=True)
    previous = ''
    while time.monotonic() - started < 210:
        result = browser.get('/api/v1/ai/shared/jobs/' + job_id).json()
        if result['state'] != previous:
            print(json.dumps({'state': result['state'], 'elapsed_seconds': result['elapsed_seconds']}), flush=True)
            previous = result['state']
        if result['state'] in {'completed', 'failed', 'cancelled'}:
            break
        time.sleep(1)
    else:
        browser.delete('/api/v1/ai/shared/jobs/' + job_id)
        raise AssertionError('Live generation did not finish within its bounded budget')
    (artifacts / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    assert result['state'] == 'completed', result.get('detail')
    plan = result['result']['plan']
    assert len(plan['tasks']) == 2 and all(item['minutes'] == 45 for item in plan['tasks'])
    assert browser.get('/api/v1/learning/goals').json() == [], 'Only a draft may be created'
    print(json.dumps({'status': 'passed', 'days': len(plan['tasks']), 'seconds': round(time.monotonic() - started, 2)}), flush=True)
