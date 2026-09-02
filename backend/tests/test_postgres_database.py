from postgres_database import PostgresMeetingRepository


def test_postgres_search_query_uses_safe_prefix_terms() -> None:
    assert PostgresMeetingRepository._to_tsquery("Architecture review") == (
        "'Architecture':* & 'review':*"
    )
    assert PostgresMeetingRepository._to_tsquery('***" OR') == "'OR':*"
    assert PostgresMeetingRepository._to_tsquery("   ") == ""
