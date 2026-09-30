from __future__ import annotations

import uvicorn

from .config import load_settings


def main() -> None:
    settings = load_settings()
    uvicorn.run(
        "app.main:create_app",
        host=settings.host,
        port=settings.port,
        reload=False,
        factory=True,
    )


if __name__ == "__main__":
    main()
