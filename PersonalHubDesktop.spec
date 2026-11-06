# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path
import ssl
from PyInstaller.utils.hooks import collect_submodules

datas = [('frontend/dist', 'frontend/dist'), ('backend/migrations', 'backend/migrations'),
         ('backend/alembic.ini', 'backend')]
policy = Path(ssl.__file__).with_name('codex-rejected-cas.pem')
if policy.is_file():
    datas.append((str(policy), '.'))
a = Analysis(['backend/personalhub_desktop_entry.py'], pathex=['backend'], binaries=[], datas=datas,
             hiddenimports=collect_submodules('uvicorn'), hookspath=[], hooksconfig={}, runtime_hooks=[],
             excludes=[], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='PersonalHub', debug=False,
          bootloader_ignore_signals=False, strip=False, upx=False, console=True,
          disable_windowed_traceback=False, argv_emulation=False, target_arch=None,
          codesign_identity=None, entitlements_file=None)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='PersonalHub')
