from fastapi import APIRouter

from .agenda import router as agenda_router
from .development import router as development_router
from .home import router as home_router
from .media import router as media_router
from .consulting import router as consulting_router
from .learning import router as learning_router
from .learning_extension import router as learning_extension_router
from .focus import router as focus_router
from .diet import router as diet_router
from .diet_templates import router as diet_templates_router
from .system import router as system_router
from .ai import router as ai_router
from .diet_ai import router as diet_ai_router
from .daily_activities import router as daily_activities_router


api_router = APIRouter(prefix="/api/v1")
api_router.include_router(agenda_router)
api_router.include_router(development_router)
api_router.include_router(home_router)
api_router.include_router(media_router)
api_router.include_router(consulting_router)
api_router.include_router(learning_router)
api_router.include_router(learning_extension_router)
api_router.include_router(focus_router)
api_router.include_router(diet_router)
api_router.include_router(diet_templates_router)
api_router.include_router(system_router)
api_router.include_router(ai_router)
api_router.include_router(diet_ai_router)
api_router.include_router(daily_activities_router)
