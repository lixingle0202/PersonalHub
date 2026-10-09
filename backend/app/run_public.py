"""Start the separate account-isolated service behind an HTTPS tunnel."""

from __future__ import annotations

import uvicorn

from .public import create_public_app


def main() -> None:
    uvicorn.run(create_public_app(), host="127.0.0.1", port=8766, access_log=False,
                proxy_headers=True, forwarded_allow_ips="127.0.0.1")


if __name__ == "__main__":
    main()
