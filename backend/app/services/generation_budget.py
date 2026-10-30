from contextvars import ContextVar
from dataclasses import dataclass
from threading import Event
import time

from fastapi import HTTPException


@dataclass(frozen=True)
class GenerationBudget:
    deadline: float
    cancelled: Event


current_budget: ContextVar[GenerationBudget | None] = ContextVar('generation_budget', default=None)


def remaining_seconds(default: float = 300) -> float:
    budget = current_budget.get()
    if budget is None:
        return default
    if budget.cancelled.is_set():
        raise HTTPException(499, '已取消这次生成，可以重新安排')
    remaining = budget.deadline - time.monotonic()
    if remaining <= 0:
        raise HTTPException(504, '共享模型生成用时过长，本次已停止且不会扣除生成次数，请缩短天数后重试')
    return min(default, remaining)
