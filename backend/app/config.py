from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path


APP_DIRECTORY_NAME = "PersonalHub"


def default_data_root() -> Path:
    override = os.environ.get("PERSONAL_HUB_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    return base / APP_DIRECTORY_NAME


@dataclass(frozen=True)
class Settings:
    data_root: Path
    host: str = "127.0.0.1"
    port: int = 8765
    dev_origin: str | None = None
    allowed_hosts: tuple[str, ...] = ("127.0.0.1", "localhost", "testserver")

    @property
    def database_path(self) -> Path:
        return self.data_root / "data" / "personal_data.db"

    @property
    def backup_path(self) -> Path:
        return self.data_root / "backups"

    @property
    def log_path(self) -> Path:
        return self.data_root / "logs"

    def ensure_directories(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.backup_path.mkdir(parents=True, exist_ok=True)
        self.log_path.mkdir(parents=True, exist_ok=True)


def load_settings() -> Settings:
    return Settings(
        data_root=default_data_root(),
        host="127.0.0.1",
        port=int(os.environ.get("PERSONAL_HUB_PORT", "8765")),
        dev_origin=os.environ.get("PERSONAL_HUB_DEV_ORIGIN"),
    )
