# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path
import ssl

from PyInstaller.utils.hooks import collect_submodules


hidden_imports = collect_submodules("uvicorn")
package_data = [
    ("frontend/dist", "frontend/dist"),
    ("backend/migrations", "backend/migrations"),
    ("backend/alembic.ini", "backend"),
]
# This Python runtime loads its TLS policy next to ssl.py. Keep that policy
# beside the frozen module so HTTPX can initialize without developer files.
tls_policy = Path(ssl.__file__).with_name("codex-rejected-cas.pem")
if tls_policy.is_file():
    package_data.append((str(tls_policy), "."))

a = Analysis(
    ["backend/personalhub_entry.py"],
    pathex=["backend"],
    binaries=[],
    datas=package_data,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="PersonalHub",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="PersonalHub",
)
