from copy import deepcopy
import json
from types import SimpleNamespace

import pytest

from app.services import ollama
from app.services.learning_quality import actionable_verification, validate_task_variety


def entry(notes):
    return SimpleNamespace(notes=notes)


def test_only_changing_dates_numbers_or_topic_words_does_not_make_different_tasks():
    tasks = [entry(f'第{day}天15分钟：阅读教材，选择{topic}相关章节；15分钟：笔记记录，整理{topic}概念；'
                   '15分钟：复习笔记；产出：知识笔记；验收：对照教材逐条核对概念。')
             for day, topic in [(1, '高频电子线路'), (2, '电路分析与设计'), (3, '信号处理与滤波器')]]
    with pytest.raises(ValueError, match='高度重复'):
        validate_task_variety(tasks)


def test_concrete_progression_is_allowed_and_vague_verification_is_rejected():
    tasks = [entry('20分钟：计算指定LC电路的谐振频率；25分钟：改变电容量并画出频率变化趋势；产出：计算表；验收：代回公式核对单位和数量级。'),
             entry('15分钟：辨认调幅信号包络和载波；30分钟：比较过调制与欠调制波形并标注差异；产出：两组波形图；验收：对照波形解释失真原因。')]
    validate_task_variety(tasks)
    with pytest.raises(ValueError, match='验收过于含糊'):
        validate_task_variety([entry('阅读谐振教材并总结概念关系；产出：知识笔记；验收：确保理解高频电子电路的基本概念和术语')])


def test_vague_generated_verification_gets_a_subject_appropriate_check_without_changing_concrete_checks():
    waveform = actionable_verification('闭卷复述，确保理解', '辨认调幅包络和过调制波形')
    calculation = actionable_verification('确保理解计算方法', '代入LC谐振公式计算频率并核对单位')
    assert '对照参考图' in waveform and '失真部位' in waveform
    assert '独立重算' in calculation and '单位和数量级' in calculation
    concrete = '对照教材逐项核对概念解释，标记遗漏或误解'
    assert actionable_verification(concrete, '阅读并梳理教材') == concrete


def test_repeated_daily_steps_are_rewritten_once_using_specific_feedback(monkeypatch):
    request = ollama.LearningGenerateRequest(topic='高频电子线路', objective='理解LC谐振和调幅信号的特点',
        start_date='2026-12-01', days=2, daily_minutes=45)
    good = {'name': '谐振与调幅学习', 'goal': request.objective, 'sections': ['谐振计算', '波形辨析'], 'tasks': [
        {'day_number': 1, 'section_index': 0, 'title': '计算LC谐振频率并检验单位', 'minutes': 45,
         'steps': [{'minutes': 20, 'action': '给定电感和电容量，代入LC谐振公式计算频率'}, {'minutes': 25, 'action': '改变电容量，比较谐振频率变化并解释关系'}],
         'deliverable': '频率计算表和电容变化趋势说明', 'verification': '代回公式核对计算结果、单位与数量级'},
        {'day_number': 2, 'section_index': 1, 'title': '辨认调幅包络与过调制失真', 'minutes': 45,
         'steps': [{'minutes': 15, 'action': '观察调幅波形，标注包络、载波和调制信号的对应关系'}, {'minutes': 30, 'action': '画出正常调幅与过调制波形，逐项解释失真产生原因'}],
         'deliverable': '两组波形标注图及失真原因分析', 'verification': '对照波形逐项核对包络变化，解释过调制的区别'},
    ]}
    calls = []

    def inference(_settings, _path, payload):
        calls.append(payload)
        result = deepcopy(good)
        if len(calls) == 1:
            for task in result['tasks']:
                task.pop('steps')
                task['notes'] = '阅读教材，选择相关章节；笔记记录，整理相关概念；产出：概念笔记；验收：对照教材核对概念。'
        else:
            assert '高度重复' in payload['messages'][-1]['content']
        return {'message': {'content': json.dumps(result)}}

    monkeypatch.setattr(ollama, 'ollama_request', inference)
    result = ollama.generate_learning_plan(ollama.OllamaSettings(model='test-model'), request)
    assert len(calls) == 2
    assert 'LC谐振公式' in result.tasks[0].notes and '过调制波形' in result.tasks[1].notes
    assert all(task.minutes == 45 for task in result.tasks)


@pytest.mark.parametrize('model,expected_calls', [('qwen2.5:1.5b', 4), ('other-model', 5)])
def test_persistent_repetition_is_repaired_with_distinct_outline_and_individual_daily_objectives(monkeypatch, model, expected_calls):
    request = ollama.LearningGenerateRequest(topic='高频电子线路', objective='计算LC谐振频率并辨认调幅失真波形',
        start_date='2026-12-01', days=2, daily_minutes=45)
    focuses = [
        {'focus': '计算LC谐振频率', 'objective': '完成一个LC谐振频率算例并核对单位'},
        {'focus': '辨认调幅失真波形', 'objective': '标注正常调幅与过调制的波形差异'},
    ]
    actions = ['给定电感和电容参数代入LC谐振公式计算频率，改变电容量比较结果', '画出调幅包络与载波，标注过调制失真部位并解释原因']
    calls = []

    def inference(_settings, _path, payload):
        calls.append(payload)
        if 'days' in payload['format']['properties']:
            result = {'days': focuses}
        else:
            requirements = json.loads(payload['messages'][1]['content'])
            if requirements['days'] == 2:
                result = {'name': '重复计划', 'goal': request.objective, 'sections': ['谐振与调幅'], 'tasks': [
                    {'day_number': index + 1, 'section_index': 0, 'title': '重复学习全部目标', 'minutes': 45,
                     'notes': '阅读电路教材并练习谐振计算；产出：电路笔记；验收：对照公式核对计算结果。'} for index in range(2)]}
            else:
                index = next(index for index, focus in enumerate(focuses) if focus['objective'] == requirements['objective'])
                assert requirements['daily_minutes'] == 45
                result = {'name': '当天学习', 'goal': focuses[index]['objective'], 'sections': [focuses[index]['focus']], 'tasks': [
                    {'day_number': 1, 'section_index': 0, 'title': focuses[index]['focus'], 'minutes': 45,
                     'notes': actions[index] + '；产出：本日计算或波形分析记录；验收：独立复算或标注后对照例题核对差异。'}]}
        return {'message': {'content': json.dumps(result)}}

    monkeypatch.setattr(ollama, 'ollama_request', inference)
    result = ollama.generate_learning_plan(ollama.OllamaSettings(model=model), request)
    assert len(calls) == expected_calls
    assert [task.title for task in result.tasks] == [focus['focus'] for focus in focuses]
    assert [str(task.plan_date) for task in result.tasks] == ['2026-12-01', '2026-12-02']
    assert result.goal == request.objective and all(task.minutes == 45 for task in result.tasks)
