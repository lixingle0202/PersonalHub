from __future__ import annotations

import json
import re
from copy import deepcopy
from collections import defaultdict
from datetime import date, timedelta
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from .cloud_model import BailianSettings, bailian_request

from .learning_subject import subject_guidance, theory_daily_focus, validate_subject_scope
from .generation_budget import current_budget, remaining_seconds
from .learning_quality import actionable_verification, validate_task_variety


class LocalEndpoint(BaseModel):
    base_url: str = "http://127.0.0.1:11434"

    @field_validator("base_url")
    @classmethod
    def local_url(cls, value: str) -> str:
        value = value.strip().rstrip('/')
        parts = urlsplit(value)
        if (parts.scheme not in {"http", "https"} or parts.hostname not in {"127.0.0.1", "localhost", "::1"}
                or parts.username or parts.password or parts.path or parts.query or parts.fragment):
            raise ValueError("请填写本机 Ollama 地址，例如 http://127.0.0.1:11434")
        try:
            _ = parts.port
        except ValueError as exc:
            raise ValueError("Ollama 端口不正确") from exc
        return value


class OllamaSettings(LocalEndpoint):
    model: str = Field(default="", max_length=200)

    @field_validator("model")
    @classmethod
    def clean_model(cls, value: str) -> str:
        return value.strip()


class LearningGenerateRequest(BaseModel):
    topic: str = Field(min_length=1, max_length=200)
    objective: str = Field(min_length=1, max_length=2000)
    current_level: str = Field(default="零基础", max_length=1000)
    preferences: str = Field(default="", max_length=2000)
    start_date: date
    days: int = Field(default=7, ge=1, le=30)
    daily_minutes: int = Field(default=45, ge=5, le=480)

    @field_validator("topic", "objective")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("学习主题和目标不能为空")
        return value.strip()


class StudyStep(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    minutes: int = Field(ge=1, le=480)
    action: str = Field(min_length=4, max_length=300)


class ModelTask(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    day_number: int = Field(ge=1, le=30)
    section_index: int = Field(ge=0)
    title: str = Field(min_length=1, max_length=300)
    minutes: int = Field(ge=1, le=480)
    notes: str = Field(default="", max_length=2000)
    steps: list[StudyStep] = Field(default_factory=list, max_length=4)
    deliverable: str = Field(default="", max_length=300)
    verification: str = Field(default="", max_length=300)


class ModelLearningPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=200)
    goal: str = Field(min_length=1, max_length=2000)
    sections: list[str] = Field(min_length=1, max_length=30)
    tasks: list[ModelTask] = Field(min_length=1, max_length=90)


class PreviewTask(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    plan_date: date
    section_index: int = Field(ge=0)
    title: str = Field(min_length=1, max_length=300)
    minutes: int = Field(ge=1, le=480)
    notes: str = Field(default="", max_length=2000)


class LearningPreview(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=200)
    goal: str = Field(min_length=1, max_length=2000)
    start_date: date
    target_date: date
    daily_minutes: int = Field(ge=5, le=480)
    sections: list[str] = Field(min_length=1, max_length=30)
    tasks: list[PreviewTask] = Field(min_length=1, max_length=90)

    @model_validator(mode="after")
    def valid_schedule(self):
        if not 0 <= (self.target_date - self.start_date).days < 30:
            raise ValueError("计划日期范围必须为 1 至 30 天")
        if any(not name.strip() or len(name) > 200 for name in self.sections):
            raise ValueError("章节名称不能为空或超过 200 字")
        self.sections = [name.strip() for name in self.sections]
        daily_totals = defaultdict(int)
        seen = set()
        for task in self.tasks:
            if not self.start_date <= task.plan_date <= self.target_date:
                raise ValueError("学习任务日期超出计划范围")
            if task.section_index >= len(self.sections):
                raise ValueError("学习任务引用了不存在的章节")
            key = (task.plan_date, task.title)
            if key in seen:
                raise ValueError("同一天的学习任务不能重复")
            seen.add(key)
            daily_totals[task.plan_date] += task.minutes
        if any(total > self.daily_minutes for total in daily_totals.values()):
            raise ValueError("某天的任务总时长超过每天可用时间，请调整后重试")
        return self


def ollama_request(settings: LocalEndpoint, path: str, payload: dict | None = None) -> dict:
    timeout = remaining_seconds(300 if payload else 10)
    if isinstance(settings, BailianSettings):
        result = bailian_request(settings, path, payload)
        remaining_seconds()
        return result
    if payload is not None and path == '/api/chat':
        # Reuse the loaded weights between plans instead of paying cold-start cost.
        payload = {'keep_alive': '30m', **payload}
    try:
        with httpx.Client(timeout=httpx.Timeout(timeout, connect=min(3, timeout)),
                          trust_env=False, follow_redirects=False) as client:
            if payload is not None and path == '/api/chat' and current_budget.get() is not None:
                # Streaming lets a cancelled shared job close the model connection
                # between tokens instead of occupying capacity until the full plan ends.
                with client.stream('POST', f'{settings.base_url}{path}', json={**payload, 'stream': True}) as response:
                    if response.status_code == 404:
                        raise HTTPException(422, '共享模型未安装，请管理员检查模型配置')
                    if response.status_code != 200:
                        raise HTTPException(502, f'共享模型服务返回错误（{response.status_code}），请稍后重试')
                    content = []
                    size = 0
                    result = {}
                    for line in response.iter_lines():
                        remaining_seconds()
                        if not line.strip():
                            continue
                        chunk = json.loads(line)
                        if not isinstance(chunk, dict) or chunk.get('error'):
                            raise ValueError('Invalid model stream')
                        fragment = chunk.get('message', {}).get('content', '')
                        if not isinstance(fragment, str):
                            raise ValueError('Invalid model content')
                        content.append(fragment)
                        size += len(fragment)
                        if size > 160_000:
                            raise HTTPException(502, '模型输出过长，请缩短计划天数后重试')
                        if chunk.get('done'):
                            result = chunk
                    if not result.get('done'):
                        raise HTTPException(502, '模型连接中断，未收到完整计划，本次未扣除生成次数，请重试')
                    return {**result, 'message': {'content': ''.join(content)}}
            response = client.get(f"{settings.base_url}{path}") if payload is None else client.post(f"{settings.base_url}{path}", json=payload)
            if response.status_code == 404 and path == "/api/chat":
                raise HTTPException(422, "模型未安装或模型名称不正确，请在本地大模型设置中刷新模型列表")
            if response.status_code != 200:
                raise HTTPException(502, f"Ollama 返回错误（{response.status_code}），请检查本机模型服务")
            data = response.json()
            if not isinstance(data, dict) or data.get("error"):
                raise ValueError("Invalid Ollama response")
            return data
    except httpx.TimeoutException as exc:
        raise HTTPException(504, "本地模型响应超时，请缩短计划天数或换用更小的模型后重试") from exc
    except httpx.RequestError as exc:
        raise HTTPException(503, "无法连接本机 Ollama，请先安装并启动 Ollama，再检查服务地址") from exc
    except (ValueError, TypeError) as exc:
        raise HTTPException(502, "Ollama 返回的数据格式不正确，请检查本地模型服务") from exc


def list_models(settings: LocalEndpoint) -> list[str]:
    data = ollama_request(settings, "/api/tags")
    models = data.get("models")
    if not isinstance(models, list):
        raise HTTPException(502, "Ollama 模型列表格式不正确")
    return sorted({model['name'] for model in models if isinstance(model, dict) and isinstance(model.get('name'), str)})


def learning_chat_payload(request: LearningGenerateRequest, *, context: str = "") -> dict:
    schema = ModelLearningPlan.model_json_schema()
    # Exact daily slots and enumerated minutes also constrain small local models.
    # Keep the preview validator independent: imported drafts may contain several tasks per day.
    daily_slots = []
    max_sections = min(5, request.days)
    shared_slot = deepcopy(schema['$defs']['ModelTask'])
    shared_slot['properties']['day_number'] = {'type': 'integer', 'enum': list(range(1, request.days + 1))}
    shared_slot['properties']['section_index'] = {'type': 'integer', 'enum': list(range(max_sections))}
    shared_slot['properties']['minutes'] = {'type': 'integer', 'enum': [request.daily_minutes]}
    shared_slot['properties']['steps']['minItems'] = 2
    shared_slot['properties']['steps']['maxItems'] = 3
    shared_slot['properties']['deliverable']['minLength'] = 4
    shared_slot['properties']['verification']['minLength'] = 4
    # Concise fields avoid small models filling their budget with repetitive
    # assurances instead of writing distinct daily activities.
    for field in ('deliverable', 'verification'):
        shared_slot['properties'][field]['maxLength'] = 60
    shared_slot['properties']['title']['maxLength'] = 50
    schema['$defs']['StudyStep']['properties']['action']['maxLength'] = 70
    # The preview constructs notes from steps/outcomes. Generating them again
    # wastes tokens and often repeats the full day's instructions verbatim.
    shared_slot['properties']['notes'] = {'type': 'string', 'enum': ['']}
    shared_slot['properties']['deliverable']['description'] = '与本学科和目标对应的具体成果，说明数量或完成范围，不引入无关技能'
    shared_slot['properties']['verification']['description'] = '与当天成果对应的检查动作和判据，如闭卷复述后对照教材标出遗漏或错义，不只写确保理解'
    shared_slot['properties']['verification']['pattern'] = '^(对照|独立|闭卷|复算|复现|核对|计算|画出|标注|比较|检查|举例|朗读|录音).+$'
    shared_slot['properties']['title']['description'] = '动作加具体知识点，不要只写先修知识、专项练习、应用等阶段名称'
    shared_slot['required'] = list(dict.fromkeys([*shared_slot['required'], 'steps', 'deliverable', 'verification']))
    # The grammar's property order affects small models: commit to a concrete
    # outcome before describing its activities, rather than inventing preparation first.
    field_order = ('day_number', 'section_index', 'minutes', 'deliverable', 'verification', 'steps', 'title', 'notes')
    shared_slot['properties'] = {key: shared_slot['properties'][key] for key in field_order}
    for day in range(1, request.days + 1):
        slot = deepcopy(shared_slot)
        slot['properties']['day_number'] = {'type': 'integer', 'enum': [day]}
        slot['properties']['section_index'] = {'type': 'integer', 'enum': list(range(max_sections))}
        slot['properties']['minutes'] = {'type': 'integer', 'enum': [request.daily_minutes]}
        daily_slots.append(slot)
    # Ollama's grammar consumes the standard items schema; prefixItems alone
    # is insufficient to constrain values on every supported local model.
    schema['properties']['tasks'] = {'type': 'array', 'items': shared_slot, 'prefixItems': daily_slots,
                                     'minItems': request.days, 'maxItems': request.days}
    schema['properties']['sections']['minItems'] = min(2, request.days)
    schema['properties']['sections']['maxItems'] = max_sections
    schema['properties']['goal']['enum'] = [request.objective]
    if request.days == 1:
        # A one-day request must be a complete goal, not day one of an invented syllabus.
        schema['properties']['sections']['items'] = {'type': 'string', 'enum': [request.objective[:200]]}
    instructions = (
        "你是中文学习计划设计师，只输出JSON。topic限定学科，objective是本次必须完成的学习结果，"
        "current_level是已具备的基础，preferences是具体限制。优先目标和限制，不套用主题通用大纲。"
        "学习方式必须适合学科：理论课程安排阅读、概念辨析、回忆和答题；编程目标才安排代码练习。"
        "未明确要求跨学科工具时，毛概的理论或论点用自己的话解释、联系材料分析，不用Python实现或产出代码。"
        "严格遵守指定章节、资料和排除项；未提供教材内容时沿用用户指定的范围，不编造章节标题、页码或题目来源。"
        "每天安排具体学习活动，不安排无关的安装环境、泛泛复习已会内容或‘考试准备’占位。"
        "只有一天也要落实目标要求；最后一天的成果必须直接达到目标。"
        "目标要求计算就实际计算，要求阅读和复述就安排阅读和复述。"
        f"tasks恰好{request.days}项，day_number从1到{request.days}各一次并排序，每项minutes={request.daily_minutes}。"
        "每项steps含2至3个学习活动，填写minutes和action，分钟合计等于当天minutes。"
        "每个action用15至40字写清操作；产出和验收各用15至35字。notes留空，系统自动组合说明，避免重复输出。"
        "action写动作、具体对象、数量或算例；title写当天操作，每天标题和步骤不同，不写准备阶段等空泛标题。"
        "不能每天套用阅读教材、选择相关章节、笔记记录的同一段话；直接指出要解决的概念、例题或操作，按理解、练习、应用逐步推进。"
        "deliverable写与当天学习对象对应的成果及范围；verification明确如何对照教材、答案或目标核对成果，"
        "两者各用一句话简写，条件必须与成果直接相关，不罗列无关题目或数量，不反复写‘确保理解’。"
        "验收要以实际动作开头：计算任务复算并核对单位，阅读任务闭卷复述再对照原文，操作任务独立复现并核对结果，不能用确保理解作验收。"
        f"sections有{min(2, request.days)}至{max_sections}个不同阶段，section_index引用存在的阶段。"
        "按基础和可用时间安排合理难度与数量，每天内容不同；仅考试目标安排考试训练，不虚构资料或通过保证。"
        + subject_guidance(request.topic, request.objective, request.preferences)
    )
    requirements = request.model_dump(mode='json')
    focuses = theory_daily_focus(request.topic, request.objective, request.preferences, request.days)
    if focuses:
        requirements['daily_focus'] = [{'day_number': index, 'focus': focus}
                                       for index, focus in enumerate(focuses, 1)]
    if context:
        requirements['planning_context'] = context
    return {
        "stream": False, "think": False, "format": schema,
        "options": {"temperature": 0.2, "num_ctx": 8192, "num_predict": min(8192, 600 + request.days * 650)},
        "messages": [{"role": "system", "content": instructions},
                     {"role": "user", "content": json.dumps(requirements, ensure_ascii=False)}],
    }


def learning_preview_from_response(request: LearningGenerateRequest, data: dict) -> LearningPreview:
    try:
        if data.get('done') is False or data.get('done_reason') == 'length':
            raise ValueError("模型输出未完成，请缩短计划天数后重试")
        result = ModelLearningPlan.model_validate_json(data['message']['content'])
        for task in result.tasks:
            if task.steps:
                if sum(step.minutes for step in task.steps) != task.minutes:
                    # Small models often get the arithmetic wrong. Keep their
                    # activity proportions, but fit integer minutes to the budget.
                    remaining = task.minutes - len(task.steps)
                    if remaining < 0:
                        raise ValueError('当天分钟不足以安排分项活动')
                    weights = sum(step.minutes for step in task.steps)
                    shares = [remaining * step.minutes / weights for step in task.steps]
                    minutes = [1 + int(share) for share in shares]
                    order = sorted(range(len(minutes)), key=lambda index: shares[index] % 1, reverse=True)
                    for index in order[:task.minutes - sum(minutes)]:
                        minutes[index] += 1
                    for step, allocated in zip(task.steps, minutes):
                        step.minutes = allocated
                if not task.deliverable or not task.verification:
                    raise ValueError('每天必须有明确产出和验收标准')
                task.verification = actionable_verification(task.verification, '；'.join(step.action for step in task.steps))
                task.notes = '；'.join(f'{step.minutes}分钟：{step.action}' for step in task.steps)
                task.notes += f'；产出：{task.deliverable}；验收：{task.verification}'
                task.title = re.sub(r'^(?:学习)?阶段\s*\d+\s*[:：]\s*', '', task.title)
                if task.title in {'先修知识', '专项练习', '应用', '复盘', '基础复习', '准备阶段', '复习已会知识'}:
                    # Use the model's concrete activity, rather than a phase-only heading.
                    task.title = task.steps[-1].action[:100]
        if {task.day_number for task in result.tasks} != set(range(1, request.days + 1)):
            raise ValueError("模型没有完整覆盖计划天数，请重新生成或缩短天数")
        validate_generated_quality(request, result)
        name = f'{request.topic[:196]}学习计划' if re.fullmatch(r'\d{4}-\d{2}-\d{2}', result.name) else result.name
        return LearningPreview(
            name=name, goal=request.objective, sections=result.sections,
            start_date=request.start_date, target_date=request.start_date + timedelta(days=request.days - 1),
            daily_minutes=request.daily_minutes,
            tasks=[PreviewTask(plan_date=request.start_date + timedelta(days=task.day_number - 1),
                               section_index=task.section_index, title=task.title, minutes=task.minutes,
                               notes=task.notes) for task in result.tasks],
        )
    except (ValidationError, KeyError, TypeError, ValueError) as exc:
        detail = exc.errors()[0]['msg'] if isinstance(exc, ValidationError) else str(exc)
        raise HTTPException(502, f"生成的学习计划未通过校验：{detail}。尚未写入学习计划，可重新生成。") from exc


def validate_generated_quality(request: LearningGenerateRequest, result: ModelLearningPlan) -> None:
    """Only generated output is strict; an edited/imported draft may use less time."""
    # Check every visible field, including legacy notes and structured outcomes.
    # Merely putting the right subject in the heading cannot justify foreign tasks.
    content = '；'.join([result.name, result.goal, *result.sections, *(
        '；'.join([task.title, task.notes, task.deliverable, task.verification,
                  *(step.action for step in task.steps)]) for task in result.tasks
    )])
    validate_subject_scope(request.topic, request.objective, request.preferences, content)
    generic = {'考试准备', '综合考试准备', '复习总结', '复习', '学习', '练习', '学习任务'}
    titles = [task.title.strip() for task in result.tasks]
    if len(set(titles)) != len(titles) or any(title in generic for title in titles):
        raise ValueError('任务标题重复或过于笼统，请写出每天不同的具体知识点和学习活动；'
                         '同一节可依次安排阅读梳理、闭卷复述、辨析订正，不得复制上一天的标题和步骤')
    if len(set(result.sections)) != len(result.sections):
        raise ValueError('学习阶段重复，请合并相同阶段并细化每日任务')
    totals = defaultdict(int)
    for task in result.tasks:
        totals[task.day_number] += task.minutes
        if len(task.notes) < 30 or not any(word in task.notes for word in ('产出', '成果')) or not any(word in task.notes for word in ('验收', '自测', '检查')):
            raise ValueError('每天的任务说明必须包含具体学习步骤、产出和验收标准，不能只写笼统提示')
        if task.verification and any(phrase in task.verification for phrase in ('所有内容', '全部内容', '所有复习内容', '全部知识')):
            raise ValueError('验收不能只说包含所有内容，请给出具体题目数量、测试结果或独立复现条件')
    if any(total != request.daily_minutes for total in totals.values()):
        raise ValueError(f'每天必须按用户填写的{request.daily_minutes}分钟完整安排，不能统一使用30分钟')
    if len(result.tasks) > 3 and len({task.notes for task in result.tasks}) < len(result.tasks) * 0.7:
        raise ValueError('每日说明大量重复，请针对每天的具体内容分别安排')
    # A correct goal heading alone is insufficient: requested specialist tools
    # must occur in the actual activities, rather than generic language lessons.
    topic_terms = {term.casefold() for term in re.findall(r'[A-Za-z][A-Za-z0-9_.+#-]*', request.topic)}
    required_terms = set()
    if not any(word in request.objective for word in ('或者', '任选', '或')):
        for clause in re.split(r'[，,；;。\n]', request.objective):
            if any(word in clause for word in ('不要', '不使用', '不用', '禁止', '避免', '无需', '不需要')):
                continue
            required_terms.update(term for term in re.findall(r'[A-Za-z][A-Za-z0-9_.+#-]*', clause)
                                  if len(term) >= 3 and term.casefold() not in topic_terms
                                  and term.casefold() not in {'app', 'web', 'api'})
            # These explicit chart types are different outputs, even when the
            # same plotting library is used. Do not accept a scatter plot for a line chart.
            required_terms.update(term for term in ('折线图', '散点图', '柱状图', '直方图', '饼图') if term in clause)
    normalize = lambda text: re.sub(r'[-_]', '', text.casefold())
    activities = normalize(' '.join(' '.join(step.action for step in task.steps)
                                  if task.steps else re.split(r'产出[：:]|成果[：:]', task.notes)[0]
                                  for task in result.tasks))
    missing = sorted(term for term in required_terms if normalize(term) not in activities)
    if missing:
        raise ValueError(f'实际学习步骤遗漏目标指定的内容或工具：{"、".join(missing)}；不能只在计划名称中提到目标')
    operations = {
        '读取': ('读取', '读出', '读回', 'reader', 'read('),
        '读回': ('读回', '读取', '读出', 'read('),
        '写入': ('写入', '写出', 'write('),
        '计算': ('计算', '求和', '总和', '求解', 'sum(', '统计'),
        '绘制': ('绘制', '画出', '画图', '绘图', 'plot('),
    }
    positive_objective = '；'.join(clause for clause in re.split(r'[，,；;。\n]', request.objective)
        if not any(word in clause for word in ('不要', '不使用', '不用', '禁止', '避免', '无需', '不需要')))
    for operation, alternatives in operations.items():
        if operation in positive_objective and not any(normalize(word) in activities for word in alternatives):
            raise ValueError(f'具体活动没有安排目标要求的“{operation}”操作；不能只写准备、安装或在验收中宣称完成')
    positive_activities = re.sub(r'(?:不要|不使用|不用|禁止使用|避免使用)\s*[A-Za-z][A-Za-z0-9_.+-]*', '', activities)
    forbidden = re.findall(r'(?:不要|不使用|不用|禁止使用|避免使用)\s*([A-Za-z][A-Za-z0-9_.+-]*)', request.preferences)
    if re.search(r'只.{0,8}标准库', request.preferences):
        forbidden.extend(['pandas', 'numpy', 'matplotlib', 'scipy', 'seaborn', 'sklearn'])
    violated = sorted({term for term in forbidden if normalize(term) in positive_activities})
    if violated:
        raise ValueError(f'实际步骤使用了用户限制的工具：{"、".join(violated)}，请遵守preferences重新安排')
    validate_task_variety(result.tasks)


def generate_learning_plan(settings: OllamaSettings, request: LearningGenerateRequest) -> LearningPreview:
    if not settings.model:
        raise HTTPException(422, "请先在数据与设置 → 本地大模型中选择并保存一个 Ollama 模型")
    sections: list[str] = []
    tasks: list[PreviewTask] = []
    name = ''
    # Keep the original requirements in every short batch so long plans do not
    # lose them as the model's context window fills up.
    for offset in range(0, request.days, 7):
        batch = request.model_copy(update={
            'days': min(7, request.days - offset),
            'start_date': request.start_date + timedelta(days=offset),
        })
        context = '' if request.days <= 7 else (
            f'这是整个{request.days}天计划的第{offset + 1}至{offset + batch.days}天。'
            f'此前已安排：{"、".join(task.title for task in tasks[-7:]) or "无"}。'
            '承接已有内容并继续推进，不得重新从入门开始或用考试准备填满后续日期。'
        )
        previous_content = ''
        correction = ''
        for attempt in range(2):
            payload = learning_chat_payload(batch, context=context)
            if previous_content:
                payload['messages'].extend([
                    {'role': 'assistant', 'content': previous_content},
                    {'role': 'user', 'content': f'纠正上一份JSON：{correction}。学习活动必须符合学科“{batch.topic}”并落实原始目标“{batch.objective}”，请重写完整计划。'},
                ])
            data = ollama_request(settings, '/api/chat', {'model': settings.model, **payload})
            try:
                preview = learning_preview_from_response(batch, data)
                if {task.title for task in tasks} & {task.title for task in preview.tasks}:
                    raise HTTPException(502, '后续日期重复了已安排的任务，请承接前段进度生成新的具体内容')
                try:
                    validate_task_variety([*tasks, *preview.tasks])
                except ValueError as exc:
                    raise HTTPException(502, str(exc)) from exc
                break
            except HTTPException as error:
                split_repetitive = offset == 0 and request.days >= 2 and any(
                    word in str(error.detail) for word in ('重复', '笼统', '含糊'))
                if split_repetitive and ('1.5b' in settings.model.casefold() or attempt):
                    from .learning_compact import generate_compact_learning
                    return generate_compact_learning(settings, request)
                if attempt:
                    raise
                message = data.get('message')
                previous_content = message.get('content', '') if isinstance(message, dict) else ''
                if not isinstance(previous_content, str):
                    previous_content = ''
                correction = str(error.detail)
                context += f' 上次输出未通过校验：{error.detail} 请纠正后重新生成完整JSON。'
        name = name or preview.name
        indices = {}
        for index, section in enumerate(preview.sections):
            if section not in sections:
                sections.append(section)
            indices[index] = sections.index(section)
        tasks.extend(task.model_copy(update={'section_index': indices[task.section_index]}) for task in preview.tasks)
    return LearningPreview(name=name, goal=request.objective, start_date=request.start_date,
                           target_date=request.start_date + timedelta(days=request.days - 1),
                           daily_minutes=request.daily_minutes, sections=sections, tasks=tasks)
