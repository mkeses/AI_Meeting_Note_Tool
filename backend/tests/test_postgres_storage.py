import os

import pytest

from postgres_database import PostgresMeetingRepository
from tests.meeting_store_contract import assert_meeting_store_contract


@pytest.mark.integration
def test_postgres_repository_implements_the_meeting_store_contract() -> None:
    database_url = os.getenv("POSTGRES_TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("POSTGRES_TEST_DATABASE_URL is not configured")

    pytest.importorskip("psycopg")
    assert_meeting_store_contract(PostgresMeetingRepository(database_url))
