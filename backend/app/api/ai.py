from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .deps import get_session
from .learning import goal_out
from ..models import AILearningDraft, AgendaItem, LearningGoal, LearningSection, LearningTask, Setting, new_id, utc_now
from ..services.ollama import LearningGenerateRequest, LearningPreview, LocalEndpoint, OllamaSettings, generate_learning_plan, learning_chat_payload, learning_preview_from_response, list_models

router = APIRouter(prefix="/ai", tags=["local-ai"])
CONFIG_KEY = 'ai_ollama'


class VisitorModelResult(BaseModel):
    requirements: LearningGenerateRequest
    content: str = Field(min_length=1, max_length=160_000)
    done: bool | None = None
    done_reason: str | None = Field(default=None, max_length=50)


def read_config(session: Session) -> OllamaSettings:
    record = session.get(Setting, CONFIG_KEY)
    return OllamaSettings.model_validate_json(record.value_json) if record else OllamaSettings()


@router.get('/ollama/settings')
def ollama_settings(session: Session = Depends(get_session)):
    return read_config(session)


@router.put('/ollama/settings')
def save_ollama_settings(payload: OllamaSettings, session: Session = Depends(get_session)):
    record = session.get(Setting, CONFIG_KEY)
    if record:
        record.value_json = payload.model_dump_json()
    else:
        session.add(Setting(key=CONFIG_KEY, value_json=payload.model_dump_json()))
    session.flush()
    return payload


@router.post('/ollama/models')
def ollama_models(payload: LocalEndpoint):
    return {'models': list_models(payload)}


@router.post('/learning/generate')
def generate_learning(payload: LearningGenerateRequest, request: Request):
    # Close the configuration transaction before waiting for model inference.
    with request.app.state.database.session() as session:
        config = read_config(session)
    plan = generate_learning_plan(config, payload)
    with request.app.state.database.session() as session:
        draft = AILearningDraft(plan_json=plan.model_dump_json())
        session.add(draft)
        session.flush()
        return {'id': draft.id, 'plan': plan, 'imported_goal_id': None}


@router.post('/learning/visitor/prepare')
def prepare_visitor_learning(payload: LearningGenerateRequest):
    # The browser calls its own loopback Ollama; the server never receives a URL.
    return learning_chat_payload(payload)


@router.post('/learning/visitor/draft')
def save_visitor_learning(payload: VisitorModelResult, session: Session = Depends(get_session)):
    plan = learning_preview_from_response(payload.requirements, {
        'message': {'content': payload.content}, 'done': payload.done, 'done_reason': payload.done_reason,
    })
    draft = AILearningDraft(plan_json=plan.model_dump_json())
    session.add(draft)
    session.flush()
    return {'id': draft.id, 'plan': plan, 'imported_goal_id': None}


@router.get('/learning/drafts/{draft_id}')
def get_learning_draft(draft_id: str, session: Session = Depends(get_session)):
    draft = session.get(AILearningDraft, draft_id)
    if not draft:
        raise HTTPException(404, "学习草稿不存在")
    return {'id': draft.id, 'plan': json.loads(draft.plan_json), 'imported_goal_id': draft.imported_goal_id}


@router.post('/learning/drafts/{draft_id}/import', status_code=status.HTTP_201_CREATED)
def import_learning_draft(draft_id: str, payload: LearningPreview, request: Request):
    # Serialize confirmation/retries, and commit every row in one transaction.
    with request.app.state.data_lock, request.app.state.database.session() as session:
        draft = session.get(AILearningDraft, draft_id)
        if not draft:
            raise HTTPException(404, "学习草稿不存在")
        if draft.imported_at:
            existing = session.get(LearningGoal, draft.imported_goal_id) if draft.imported_goal_id else None
            if not existing or existing.deleted_at:
                raise HTTPException(409, "该草稿已导入，其学习目标已被删除；请重新生成，不会重复创建")
            return goal_out(session, existing, True)
        original = LearningPreview.model_validate_json(draft.plan_json)
        if (payload.start_date, payload.target_date, payload.daily_minutes) != (original.start_date, original.target_date, original.daily_minutes):
            raise HTTPException(422, "请保留原草稿的日期范围和每日可用时间，或重新生成")
        goal = LearningGoal(name=payload.name, goal=payload.goal, start_date=payload.start_date,
                            target_date=payload.target_date, estimated_minutes=sum(task.minutes for task in payload.tasks))
        session.add(goal)
        session.flush()
        section_ids = []
        for index, name in enumerate(payload.sections):
            section = LearningSection(goal_id=goal.id, name=name, sort_order=index)
            session.add(section)
            session.flush()
            section_ids.append(section.id)
        for index, item in enumerate(sorted(payload.tasks, key=lambda task: task.plan_date)):
            task = LearningTask(id=new_id(), goal_id=goal.id, section_id=section_ids[item.section_index], title=item.title)
            session.add(task)
            agenda = AgendaItem(title=item.title, plan_date=item.plan_date, module='learning',
                                source_type='learning_task', source_id=task.id, sort_order=index + 1,
                                notes=f"学习目标：{goal.name}\n预计 {item.minutes} 分钟\n{item.notes}".strip())
            session.add(agenda)
            session.flush()
            task.agenda_id = agenda.id
        draft.plan_json = payload.model_dump_json()
        draft.imported_goal_id = goal.id
        draft.imported_at = utc_now()
        session.flush()
        return goal_out(session, goal, True)
