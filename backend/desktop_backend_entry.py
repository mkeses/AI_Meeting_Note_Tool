"""Standalone desktop entry point for the existing FastAPI application."""

from __future__ import annotations

import argparse
from collections.abc import Callable, Sequence

LOOPBACK_HOST = "127.0.0.1"
DEFAULT_TIMEOUT_KEEP_ALIVE_SECONDS = 600


def parse_port(value: str) -> int:
    """Parse a valid TCP port for the local desktop backend."""
    try:
        port = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("port must be an integer") from error

    if not 1 <= port <= 65_535:
        raise argparse.ArgumentTypeError("port must be between 1 and 65535")

    return port


def create_argument_parser() -> argparse.ArgumentParser:
    """Create the narrow command-line interface used by the Electron shell."""
    parser = argparse.ArgumentParser(
        description="Run the AI Meeting Note Tool local backend on loopback."
    )
    parser.add_argument(
        "--port",
        required=True,
        type=parse_port,
        help="Dynamically selected local TCP port.",
    )
    parser.add_argument(
        "--timeout-keep-alive",
        type=int,
        default=DEFAULT_TIMEOUT_KEEP_ALIVE_SECONDS,
        help="Uvicorn keep-alive timeout in seconds.",
    )
    return parser


def run_backend(port: int, timeout_keep_alive: int) -> None:
    """Start the existing FastAPI app without relying on the working directory."""
    import uvicorn

    from app import app

    uvicorn.run(
        app,
        host=LOOPBACK_HOST,
        port=port,
        timeout_keep_alive=timeout_keep_alive,
    )


def main(
    argv: Sequence[str] | None = None,
    run: Callable[[int, int], None] = run_backend,
) -> None:
    """Parse Electron's launch arguments and run the existing backend."""
    arguments = create_argument_parser().parse_args(argv)
    run(arguments.port, arguments.timeout_keep_alive)


if __name__ == "__main__":
    main()
