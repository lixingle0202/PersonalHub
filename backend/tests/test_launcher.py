from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.request import urlopen

from app.config import Settings
from app.launcher import (
    InstanceLock,
    RuntimeState,
    find_available_port,
    read_runtime_state,
    write_runtime_state,
)
from app.runtime_paths import frontend_dist_path


def test_find_available_port_skips_an_occupied_loopback_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied:
        occupied.bind(("127.0.0.1", 0))
        occupied.listen()
        used_port = int(occupied.getsockname()[1])
        assert find_available_port(used_port, attempts=2) != used_port


def test_instance_lock_prevents_a_second_local_owner(tmp_path):
    first = InstanceLock(tmp_path / "instance.lock")
    second = InstanceLock(tmp_path / "instance.lock")
    try:
        assert first.acquire() is True
        assert second.acquire() is False
    finally:
        second.release()
        first.release()


def test_runtime_state_is_stored_beside_the_independent_data_file(tmp_path):
    settings = Settings(data_root=tmp_path)
    settings.ensure_directories()
    state = RuntimeState(
        url="http://127.0.0.1:8765",
        pid=123,
        database_path=str(settings.database_path),
    )
    write_runtime_state(settings, state)

    assert read_runtime_state(settings) == state
    assert json.loads((tmp_path / "runtime.json").read_text(encoding="utf-8"))["pid"] == 123


def test_frontend_path_uses_the_pyinstaller_resource_root(monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    assert frontend_dist_path() == tmp_path / "frontend" / "dist"


def test_source_launcher_serves_only_loopback_and_persists_to_the_selected_directory(tmp_path):
    port = find_available_port(19000)
    project_root = Path(__file__).resolve().parents[2]
    environment = os.environ.copy()
    environment.update({
        "PERSONAL_HUB_DATA_DIR": str(tmp_path),
        "PERSONAL_HUB_PORT": str(port),
        "PERSONAL_HUB_NO_BROWSER": "1",
        "PYTHONPATH": str(project_root / "backend"),
    })
    process = subprocess.Popen(
        [sys.executable, str(project_root / "backend" / "personalhub_entry.py")],
        cwd=project_root,
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        body = None
        for _ in range(80):
            if process.poll() is not None:
                raise AssertionError(f"launcher exited early with {process.returncode}")
            try:
                with urlopen(f"http://127.0.0.1:{port}/health", timeout=0.3) as response:
                    body = json.load(response)
                break
            except OSError:
                time.sleep(0.1)
        assert body == {"status": "ok", "host": "127.0.0.1"}
        assert (tmp_path / "data" / "personal_data.db").is_file()
    finally:
        process.terminate()
        process.wait(timeout=10)
