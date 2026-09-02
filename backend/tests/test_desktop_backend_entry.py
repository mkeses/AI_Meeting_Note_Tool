from __future__ import annotations

import pytest

from desktop_backend_entry import (
    DEFAULT_TIMEOUT_KEEP_ALIVE_SECONDS,
    LOOPBACK_HOST,
    create_argument_parser,
    main,
)


def test_desktop_entry_uses_the_selected_loopback_port() -> None:
    calls: list[tuple[int, int]] = []

    main(["--port", "45678"], run=lambda port, timeout: calls.append((port, timeout)))

    assert calls == [(45678, DEFAULT_TIMEOUT_KEEP_ALIVE_SECONDS)]
    assert LOOPBACK_HOST == "127.0.0.1"


@pytest.mark.parametrize("port", ["0", "65536", "not-a-port"])
def test_desktop_entry_rejects_invalid_ports(port: str) -> None:
    with pytest.raises(SystemExit):
        create_argument_parser().parse_args(["--port", port])
