"""Bounded, process-local protection for repeated authentication attempts."""

from __future__ import annotations

from collections import OrderedDict, deque
from collections.abc import Callable
from math import ceil
from time import monotonic


class AuthenticationAttemptLimiter:
    """Track recent failed attempts without retaining credentials or payloads."""

    def __init__(
        self,
        *,
        max_attempts: int,
        window_seconds: float,
        max_entries: int,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        if max_attempts <= 0 or window_seconds <= 0 or max_entries <= 0:
            raise ValueError("Authentication rate-limit values must be positive")

        self._max_attempts = max_attempts
        self._window_seconds = window_seconds
        self._max_entries = max_entries
        self._clock = clock
        self._attempts: OrderedDict[str, deque[float]] = OrderedDict()

    def is_limited(self, key: str) -> bool:
        now = self._clock()
        self._expire(now)
        attempts = self._attempts.get(key)
        return attempts is not None and len(attempts) >= self._max_attempts

    def record_attempt(self, key: str) -> None:
        now = self._clock()
        self._expire(now)

        attempts = self._attempts.get(key)
        if attempts is None:
            while len(self._attempts) >= self._max_entries:
                self._attempts.popitem(last=False)
            attempts = deque()
            self._attempts[key] = attempts
        else:
            self._attempts.move_to_end(key)

        attempts.append(now)

    def reset(self, key: str) -> None:
        self._attempts.pop(key, None)

    def retry_after_seconds(self, key: str) -> int:
        now = self._clock()
        self._expire(now)
        attempts = self._attempts.get(key)
        if attempts is None or len(attempts) < self._max_attempts:
            return 0

        remaining = attempts[0] + self._window_seconds - now
        return max(1, ceil(remaining))

    @property
    def entry_count(self) -> int:
        return len(self._attempts)

    def _expire(self, now: float) -> None:
        cutoff = now - self._window_seconds
        for key, attempts in list(self._attempts.items()):
            while attempts and attempts[0] <= cutoff:
                attempts.popleft()
            if not attempts:
                del self._attempts[key]
