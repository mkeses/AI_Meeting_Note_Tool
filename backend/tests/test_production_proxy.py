import re
from pathlib import Path

BACKEND_DIRECTORY = Path(__file__).resolve().parent.parent
PROXY_CONFIGURATION = (BACKEND_DIRECTORY / "nginx" / "default.conf.template").read_text(
    encoding="utf-8"
)
COMPOSE_CONFIGURATION = (BACKEND_DIRECTORY / "compose.production.yml").read_text(
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


def test_proxy_routes_rest_requests_to_the_internal_backend():
    assert "location /api/" in PROXY_CONFIGURATION
    assert "proxy_pass http://backend:8000;" in PROXY_CONFIGURATION
    assert "proxy_request_buffering off;" in PROXY_CONFIGURATION


def test_proxy_upgrades_and_does_not_buffer_transcription_websockets():
    assert "location = /ws/transcribe" in PROXY_CONFIGURATION
    assert "proxy_set_header Upgrade $http_upgrade;" in PROXY_CONFIGURATION
    assert "proxy_set_header Connection $connection_upgrade;" in PROXY_CONFIGURATION
    assert "proxy_request_buffering off;" in PROXY_CONFIGURATION
    assert "proxy_buffering off;" in PROXY_CONFIGURATION
    assert "proxy_read_timeout 3600s;" in PROXY_CONFIGURATION
    assert "proxy_send_timeout 3600s;" in PROXY_CONFIGURATION
    assert "proxy_connect_timeout 10s;" in PROXY_CONFIGURATION


def test_proxy_redirects_http_and_explicitly_terminates_https():
    assert "listen 80;" in PROXY_CONFIGURATION
    assert "return 301 https://$host$request_uri;" in PROXY_CONFIGURATION
    assert "listen 443 ssl;" in PROXY_CONFIGURATION
    assert "ssl_certificate /etc/nginx/certs/tls.crt;" in PROXY_CONFIGURATION
    assert "ssl_certificate_key /etc/nginx/certs/tls.key;" in PROXY_CONFIGURATION
    assert "ssl_protocols TLSv1.2 TLSv1.3;" in PROXY_CONFIGURATION


def test_only_proxy_publishes_production_ports_and_mounts_external_certificates():
    assert "ports:" not in compose_service("database")
    assert "ports:" not in compose_service("backend")
    proxy = compose_service("proxy")
    assert '"80:80"' in proxy
    assert '"443:443"' in proxy
    assert "./certs:/etc/nginx/certs:ro" in proxy


def test_proxy_log_format_excludes_queries_and_sensitive_request_data():
    log_format = re.search(
        r"log_format privacy (?P<format>.*?);",
        PROXY_CONFIGURATION,
        re.DOTALL,
    )
    assert log_format is not None
    log_text = log_format.group("format").lower()
    assert "$uri" in log_text
    for forbidden_value in ("$request", "$request_uri", "$args"):
        assert (
            re.search(rf"{re.escape(forbidden_value)}(?![a-z0-9_])", log_text) is None
        )
    for forbidden_value in (
        "cookie",
        "authorization",
        "request_body",
        "http_",
    ):
        assert forbidden_value not in log_text


def test_proxy_limits_allow_the_application_audio_limit_with_multipart_overhead():
    assert "client_max_body_size 257m;" in PROXY_CONFIGURATION
    assert "Strict-Transport-Security" in PROXY_CONFIGURATION
    assert "X-Content-Type-Options" in PROXY_CONFIGURATION
    assert "Referrer-Policy" in PROXY_CONFIGURATION
    assert "X-Frame-Options" in PROXY_CONFIGURATION
