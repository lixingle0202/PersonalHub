"""Own a portable, loopback-only Ollama process; never touch installed Ollama."""
from __future__ import annotations

import ctypes
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import time

import httpx

from ..launcher import find_available_port
from ..runtime_paths import resource_root

MODEL = 'qwen2.5:1.5b'
LOGGER = logging.getLogger(__name__)


def ai_root() -> Path:
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).resolve().parent / 'ai'
    return resource_root() / '.local-ai'


class ProcessJob:
    """Windows closes all owned model workers when the application exits."""
    def __init__(self, process: subprocess.Popen):
        self.handle = None
        if os.name != 'nt':
            return
        from ctypes import wintypes
        class BasicLimits(ctypes.Structure):
            _fields_ = [('process_time', ctypes.c_int64), ('job_time', ctypes.c_int64),
                        ('flags', wintypes.DWORD), ('minimum_ws', ctypes.c_size_t),
                        ('maximum_ws', ctypes.c_size_t), ('active_processes', wintypes.DWORD),
                        ('affinity', ctypes.c_size_t), ('priority', wintypes.DWORD), ('scheduling', wintypes.DWORD)]
        class IOCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in ('read_ops', 'write_ops', 'other_ops', 'read_bytes', 'write_bytes', 'other_bytes')]
        class ExtendedLimits(ctypes.Structure):
            _fields_ = [('basic', BasicLimits), ('io', IOCounters), ('process_memory', ctypes.c_size_t),
                        ('job_memory', ctypes.c_size_t), ('peak_process_memory', ctypes.c_size_t), ('peak_job_memory', ctypes.c_size_t)]
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel.CreateJobObjectW.restype = wintypes.HANDLE
        kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.CreateJobObjectW(None, None)
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not handle or not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(handle, int(process._handle)):
            if handle:
                kernel.CloseHandle(handle)
            raise OSError(ctypes.get_last_error(), 'Cannot own the model worker process')
        self.handle, self.kernel = handle, kernel

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


class DesktopOllama:
    def __init__(self, data_root: Path, install_root: Path | None = None):
        self.install_root = install_root or ai_root()
        self.data_root = data_root
        self.process: subprocess.Popen | None = None
        self.job: ProcessJob | None = None
        self.log = None
        self.url = ''

    def start(self) -> str:
        executable = self.install_root / 'ollama' / 'ollama.exe'
        models = self.install_root / 'models'
        manifest = models / 'manifests' / 'registry.ollama.ai' / 'library' / 'qwen2.5' / '1.5b'
        if not executable.is_file() or not manifest.is_file():
            raise RuntimeError('内置 AI 文件不完整，请完整解压软件包，保留 ai 文件夹。')
        content = json.loads(manifest.read_text(encoding='utf-8'))
        for layer in [content['config'], *content['layers']]:
            blob = models / 'blobs' / layer['digest'].replace(':', '-')
            if not blob.is_file() or blob.stat().st_size != layer['size']:
                raise RuntimeError('内置模型文件缺失或损坏，请重新解压完整软件包。')
        port = find_available_port(11435)
        self.url = f'http://127.0.0.1:{port}'
        temp = self.data_root / 'ai-temp'
        logs = self.data_root / 'logs'
        temp.mkdir(parents=True, exist_ok=True)
        logs.mkdir(parents=True, exist_ok=True)
        environment = {key: value for key, value in os.environ.items() if not key.startswith('OLLAMA_')}
        environment.update(OLLAMA_HOST=f'127.0.0.1:{port}', OLLAMA_MODELS=str(models.resolve()),
                           OLLAMA_NO_CLOUD='1', OLLAMA_NUM_PARALLEL='1', OLLAMA_MAX_LOADED_MODELS='1',
                           OLLAMA_CONTEXT_LENGTH='8192', OLLAMA_KEEP_ALIVE='30m', TEMP=str(temp), TMP=str(temp))
        self.log = (logs / 'desktop-ollama.log').open('ab')
        try:
            self.process = subprocess.Popen([str(executable.resolve()), 'serve'], cwd=executable.parent,
                                            env=environment, stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log,
                                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            self.job = ProcessJob(self.process)
            with httpx.Client(trust_env=False, timeout=.7) as client:
                deadline = time.monotonic() + 45
                while time.monotonic() < deadline:
                    if self.process.poll() is not None:
                        raise RuntimeError('内置 AI 启动失败，请查看 logs/desktop-ollama.log。')
                    try:
                        response = client.get(self.url + '/api/tags')
                        response.raise_for_status()
                        if MODEL not in [item['name'] for item in response.json().get('models', [])]:
                            raise RuntimeError('内置模型未找到，请完整解压软件包。')
                        LOGGER.info('Portable AI ready at %s (%s)', self.url, MODEL)
                        return self.url
                    except httpx.HTTPError:
                        time.sleep(.2)
            raise RuntimeError('内置 AI 启动超时，请关闭其他占用内存的软件后重试。')
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.job:
            self.job.close()
            self.job = None
        if self.process:
            if self.process.poll() is None:
                self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
            self.process = None
        if self.log:
            self.log.close()
            self.log = None
