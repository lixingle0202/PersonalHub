from __future__ import annotations

from pathlib import Path
import sys


def resource_root() -> Path:
    """Return the project root in source mode and the unpacked root in a bundle."""
    bundled_root = getattr(sys, "_MEIPASS", None)
    if bundled_root:
        return Path(bundled_root)
    return Path(__file__).resolve().parents[2]


def frontend_dist_path() -> Path:
    return resource_root() / "frontend" / "dist"


def backend_resource_path() -> Path:
    return resource_root() / "backend"
