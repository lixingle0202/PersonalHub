"""Account-isolated cloud entry point, independent of the owner's computer."""
from __future__ import annotations

import os
from pathlib import Path

from .public import PublicHub, PublicUser
from .services.cloud_model import BailianSettings


class CloudHub(PublicHub):
    def __init__(self, data_root: Path, cloud_model: BailianSettings):
        super().__init__(data_root, model=cloud_model.model, secure_cookie=True)
        self.cloud_model = cloud_model

    def _user_app(self, user: PublicUser):
        app = super()._user_app(user)
        app.state.cloud_model = self.cloud_model
        return app


def create_cloud_app() -> CloudHub:
    root = os.environ.get('PERSONAL_HUB_PUBLIC_DATA_DIR', '/var/lib/personalhub')
    return CloudHub(Path(root), BailianSettings.from_environment())
