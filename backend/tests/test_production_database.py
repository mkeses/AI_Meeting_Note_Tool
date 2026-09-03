import re
from pathlib import Path

BACKEND_DIRECTORY = Path(__file__).resolve().parent.parent
COMPOSE_CONFIGURATION = (BACKEND_DIRECTORY / "compose.production.yml").read_text(
    encoding="utf-8"
)
PRODUCTION_ENVIRONMENT = (BACKEND_DIRECTORY / ".env.production.example").read_text(
    encoding="utf-8"
)


def compose_service(name: str) -> str:
    match = re.search(
        rf"^  {re.escape(name)}:\n(?P<body>.*?)(?=^  [a-z_]+:|^volumes:)",
        COMPOSE_CONFIGURATION,
        re.MULTILINE | re.DOTALL,
    )
    assert match is not None
    return match.group("body")


def test_production_compose_keeps_postgresql_internal_and_persistent():
    database = compose_service("database")
    backend = compose_service("backend")

    assert "image: postgres:16-alpine" in database
    assert "ports:" not in database
    assert "postgres_data:/var/lib/postgresql/data" in database
    assert "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB" in database
    assert "condition: service_healthy" in backend
    assert ".env.production" in backend
    assert "postgres_data:" in COMPOSE_CONFIGURATION


def test_production_environment_selects_the_internal_postgresql_service():
    assert "MEETING_STORAGE_BACKEND=postgresql" in PRODUCTION_ENVIRONMENT
    assert "POSTGRES_DATABASE_URL=postgresql://" in PRODUCTION_ENVIRONMENT
    assert "@database:5432/" in PRODUCTION_ENVIRONMENT
