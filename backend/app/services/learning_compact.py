"""Repair a repetitive small-model plan by generating an outline, then one day at a time."""
import json
from datetime import timedelta

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import ollama
from .generation_budget import remaining_seconds
from .learning_quality import validate_task_variety
from .learning_subject import validate_subject_scope


class DailyFocus(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    focus: str = Field(min_length=4, max_length=100)
    objective: str = Field(min_length=4, max_length=300)


class LearningOutline(BaseModel):
    model_config = ConfigDict(extra='forbid')
    days: list[DailyFocus] = Field(min_length=1, max_length=30)


def generate_compact_learning(settings, request):
    remaining_seconds()
    schema = LearningOutline.model_json_schema()
    schema['properties']['days'].update(minItems=request.days, maxItems=request.days)
    data = ollama.ollama_request(settings, '/api/chat', {
        'model': settings.model, 'stream': False, 'think': False, 'format': schema,
        'options': {'temperature': .25, 'num_ctx': 8192, 'num_predict': min(5000, 250 + request.days * 130)},
        'messages': [
            {'role': 'system', 'content': (
                f'你是课程规划师。先将目标拆为{request.days}天的不重复子目标，只返回JSON，不写学习步骤。'
                'days中的每项含focus和objective。focus必须是一个具体知识点或操作，objective说明当天要解决的问题。'
                '每天只推进一个子问题，不要每天重述整个总目标；先后内容要递进，最后一天达到总目标。'
                '遵守用户指定的各天内容、已有基础和限制。不能用第几天、相关章节、基础知识、考试准备充当focus。'
                '同一小节可依次阅读梳理、闭卷复述、概念辨析和订正，每天重点与成果不同。'
            )},
            {'role': 'user', 'content': json.dumps(request.model_dump(mode='json'), ensure_ascii=False)},
        ],
    })
    try:
        if data.get('done') is False or data.get('done_reason') == 'length':
            raise ValueError('大纲输出不完整')
        outline = LearningOutline.model_validate_json(data['message']['content'])
        if len(outline.days) != request.days or len({day.focus for day in outline.days}) != request.days:
            raise ValueError('每日子目标缺失或重复')
        validate_subject_scope(request.topic, request.objective, request.preferences,
                               '；'.join(day.focus + '；' + day.objective for day in outline.days))
    except (KeyError, TypeError, ValueError, ValidationError) as exc:
        raise HTTPException(502, '模型未能拆出清晰且不重复的每日重点，本次未创建正式计划，请缩短天数或补充具体目标后重试') from exc

    tasks = []
    sections = []
    for index, focus in enumerate(outline.days):
        remaining_seconds()
        daily = request.model_copy(update={
            'days': 1, 'start_date': request.start_date + timedelta(days=index),
            'objective': focus.objective,
        })
        previous = '；'.join(f'{task.title}：{task.notes[:120]}' for task in tasks[-3:]) or '无'
        context = (f'这是整个{request.days}天计划的第{index + 1}天，原始总目标是{request.objective}。'
                   f'本日只负责“{focus.focus}”，本日成果必须落实“{focus.objective}”。'
                   f'之前已完成：{previous}。不要重复已有步骤，也不要提前把其他日期的目标全部写进今天。')
        for attempt in range(2):
            payload = ollama.learning_chat_payload(daily, context=context)
            payload['format']['properties']['tasks']['items']['properties']['title'] = {'type': 'string', 'enum': [focus.focus]}
            data = ollama.ollama_request(settings, '/api/chat', {'model': settings.model, **payload})
            try:
                preview = ollama.learning_preview_from_response(daily, data)
                validate_task_variety([*tasks, *preview.tasks])
                break
            except (HTTPException, ValueError) as exc:
                if attempt:
                    raise HTTPException(502, f'第{index + 1}天仍未生成清晰且不同的任务：{getattr(exc, "detail", str(exc))}') from exc
                context += f' 上次输出存在问题：{getattr(exc, "detail", str(exc))}。请按本日唯一重点重写，不复制其他日期。'
        mapping = {}
        for section_index, section in enumerate(preview.sections):
            if section not in sections:
                sections.append(section)
            mapping[section_index] = sections.index(section)
        tasks.extend(task.model_copy(update={'section_index': mapping[task.section_index]}) for task in preview.tasks)

    # Enforce the original goal across the complete plan, not all subgoals on every day.
    combined = ollama.ModelLearningPlan(name=f'{request.topic[:196]}学习计划', goal=request.objective,
        sections=sections, tasks=[ollama.ModelTask(day_number=index + 1, section_index=task.section_index,
            title=task.title, minutes=task.minutes, notes=task.notes) for index, task in enumerate(tasks)])
    try:
        ollama.validate_generated_quality(request, combined)
    except ValueError as exc:
        raise HTTPException(502, f'拆分后的计划未完整落实原始目标：{exc}') from exc
    return ollama.LearningPreview(name=combined.name, goal=request.objective, start_date=request.start_date,
        target_date=request.start_date + timedelta(days=request.days - 1), daily_minutes=request.daily_minutes,
        sections=sections, tasks=tasks)
