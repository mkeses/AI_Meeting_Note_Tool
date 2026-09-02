import os
from uuid import uuid4

import pytest

from postgres_database import PostgresMeetingRepository
from storage import UserConflictError
from tests.meeting_store_contract import assert_meeting_store_contract


@pytest.mark.integration
def test_postgres_repository_implements_the_meeting_store_contract() -> None:
    database_url = os.getenv("POSTGRES_TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("POSTGRES_TEST_DATABASE_URL is not configured")

    pytest.importorskip("psycopg")
    repository = PostgresMeetingRepository(database_url)
    repository.initialize()
    login = f"contract-test-{uuid4().hex}"
    user = repository.create_user(login, "not-used-for-login")
    with pytest.raises(UserConflictError):
        repository.create_user(login, "another-password-hash")
    assert_meeting_store_contract(repository.for_owner(user.id))
