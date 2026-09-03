from auth_rate_limit import AuthenticationAttemptLimiter


def test_limiter_blocks_repeated_attempts_and_expires_old_state() -> None:
    now = 100.0
    limiter = AuthenticationAttemptLimiter(
        max_attempts=2,
        window_seconds=60,
        max_entries=10,
        clock=lambda: now,
    )

    limiter.record_attempt("login:127.0.0.1")
    limiter.record_attempt("login:127.0.0.1")

    assert limiter.is_limited("login:127.0.0.1")
    assert limiter.retry_after_seconds("login:127.0.0.1") == 60

    now += 60

    assert not limiter.is_limited("login:127.0.0.1")
    assert limiter.entry_count == 0


def test_limiter_is_bounded_and_retains_only_keys_and_timestamps() -> None:
    now = 100.0
    limiter = AuthenticationAttemptLimiter(
        max_attempts=2,
        window_seconds=60,
        max_entries=2,
        clock=lambda: now,
    )

    limiter.record_attempt("login:127.0.0.1")
    limiter.record_attempt("register:127.0.0.2")
    limiter.record_attempt("login:127.0.0.3")

    assert limiter.entry_count == 2
    assert not limiter.is_limited("login:127.0.0.1")
    assert all(
        isinstance(timestamp, float)
        for values in limiter._attempts.values()
        for timestamp in values
    )
