"""Take SQLite snapshots without publishing account data or server secrets."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import os
from pathlib import Path
import sqlite3
import tarfile
import tempfile


def backup_cloud(data_root: Path, destination: Path) -> Path:
    root = data_root.resolve()
    if not (root / 'accounts.sqlite3').is_file():
        raise ValueError('Cloud accounts database not found')
    destination.mkdir(parents=True, exist_ok=True)
    sources = [root / 'accounts.sqlite3', *sorted(root.glob('users/*/data/personal_data.db'))]
    with tempfile.TemporaryDirectory(prefix='personalhub-cloud-backup-') as temporary:
        snapshot = Path(temporary)
        for source in sources:
            resolved = source.resolve()
            if not resolved.is_relative_to(root):
                raise ValueError('Unexpected database path')
            target = snapshot / source.relative_to(root)
            target.parent.mkdir(parents=True, exist_ok=True)
            with sqlite3.connect(resolved.as_uri() + '?mode=ro', uri=True) as original, sqlite3.connect(target) as copied:
                original.backup(copied)
                if copied.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                    raise ValueError('Database backup verification failed')
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        archive = destination / f'personalhub-cloud-{stamp}.tar.gz'
        with tarfile.open(archive, 'w:gz') as output:
            for source in sources:
                relative = source.relative_to(root)
                output.add(snapshot / relative, arcname=relative.as_posix())
    return archive


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('destination', nargs='?', type=Path, default=Path('/backups'))
    arguments = parser.parse_args()
    archive = backup_cloud(Path(os.environ.get('PERSONAL_HUB_PUBLIC_DATA_DIR', '/var/lib/personalhub')), arguments.destination)
    print(archive.name)
