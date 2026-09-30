from __future__ import annotations

from dataclasses import asdict, dataclass, replace
import json
import logging
import os
from pathlib import Path
import socket
import sys
import threading
import time
from typing import BinaryIO
from urllib.error import URLError
from urllib.request import urlopen
import webbrowser

import uvicorn

from .config import Settings, load_settings
from .main import create_app


LOGGER = logging.getLogger("personalhub.launcher")


@dataclass(frozen=True)
class RuntimeState:
    url: str
    pid: int
    database_path: str


class InstanceLock:
    """Small cross-platform file lock released automatically when the process exits."""

    def __init__(self, path: Path):
        self.path = path
        self._handle: BinaryIO | None = None
        self.acquired = False

    def acquire(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+b")
        handle.seek(0, 2)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, IOError):
            handle.close()
            return False
        self._handle = handle
        self.acquired = True
        return True

    def release(self) -> None:
        if not self._handle:
            return
        try:
            self._handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self._handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
        finally:
            self._handle.close()
            self._handle = None
            self.acquired = False

    def __enter__(self) -> "InstanceLock":
        self.acquire()
        return self

    def __exit__(self, *_: object) -> None:
        self.release()


def find_available_port(preferred: int, attempts: int = 40) -> int:
    for port in range(preferred, preferred + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def runtime_state_path(settings: Settings) -> Path:
    return settings.data_root / "runtime.json"


def write_runtime_state(settings: Settings, state: RuntimeState) -> None:
    target = runtime_state_path(settings)
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(asdict(state), ensure_ascii=False), encoding="utf-8")
    temporary.replace(target)


def read_runtime_state(settings: Settings) -> RuntimeState | None:
    try:
        values = json.loads(runtime_state_path(settings).read_text(encoding="utf-8"))
        return RuntimeState(
            url=str(values["url"]),
            pid=int(values["pid"]),
            database_path=str(values["database_path"]),
        )
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


def health_is_ready(url: str, expected_database_path: Path | None = None) -> bool:
    try:
        with urlopen(f"{url}/health", timeout=0.7) as response:
            if response.status != 200:
                return False
        if expected_database_path is not None:
            with urlopen(f"{url}/api/v1/bootstrap", timeout=0.7) as response:
                values = json.load(response)
            if Path(values.get("database_path", "")).resolve() != expected_database_path.resolve():
                return False
        return True
    except (OSError, URLError, ValueError, json.JSONDecodeError):
        return False


def existing_instance_url(settings: Settings, attempts: int = 60) -> str | None:
    for _ in range(attempts):
        state = read_runtime_state(settings)
        if state and health_is_ready(state.url, settings.database_path):
            return state.url
        time.sleep(0.1)
    return None


def open_browser_when_ready(url: str) -> None:
    for _ in range(60):
        if health_is_ready(url):
            try:
                webbrowser.open(url, new=2)
            except webbrowser.Error:
                LOGGER.exception("Could not open the default browser")
            return
        time.sleep(0.1)
    LOGGER.error("PersonalHub did not become ready at %s", url)


def configure_logging(settings: Settings) -> None:
    settings.ensure_directories()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(settings.log_path / "personalhub.log", encoding="utf-8"),
        ],
        force=True,
    )


def remove_own_runtime_state(settings: Settings) -> None:
    state = read_runtime_state(settings)
    if state and state.pid == os.getpid():
        runtime_state_path(settings).unlink(missing_ok=True)


def main() -> int:
    requested = load_settings()
    requested.ensure_directories()
    lock = InstanceLock(requested.data_root / "instance.lock")

    if not lock.acquire():
        url = existing_instance_url(requested)
        if url:
            if os.environ.get("PERSONAL_HUB_NO_BROWSER") != "1":
                webbrowser.open(url, new=2)
            return 0
        print("PersonalHub is already starting. Please wait a moment and try again.")
        return 1

    settings = replace(requested, port=find_available_port(requested.port))
    configure_logging(settings)
    url = f"http://{settings.host}:{settings.port}"
    state = RuntimeState(url=url, pid=os.getpid(), database_path=str(settings.database_path))

    try:
        app = create_app(settings)
        write_runtime_state(settings, state)
        if os.environ.get("PERSONAL_HUB_NO_BROWSER") != "1":
            threading.Thread(target=open_browser_when_ready, args=(url,), daemon=True).start()

        LOGGER.info("PersonalHub is available at %s", url)
        LOGGER.info("Data file: %s", settings.database_path)
        server = uvicorn.Server(
            uvicorn.Config(app, host=settings.host, port=settings.port, log_level="info", access_log=False)
        )
        server.run()
        return 0
    except Exception:
        LOGGER.exception("PersonalHub failed to start")
        return 1
    finally:
        database = getattr(locals().get("app"), "state", None)
        if database is not None and hasattr(database, "database"):
            database.database.dispose()
        remove_own_runtime_state(settings)
        lock.release()


if __name__ == "__main__":
    sys.exit(main())
