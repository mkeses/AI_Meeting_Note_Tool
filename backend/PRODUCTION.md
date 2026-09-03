# Production Remote Stack

This repository provides a production deployment foundation for the remote
application: an Nginx HTTPS/WSS edge, FastAPI, and PostgreSQL. It does not
deploy a public host, provision DNS, issue or renew certificates, or provide a
static PWA hosting service.

```text
Browser/PWA
    | HTTPS and WSS
    v
Nginx reverse proxy (:80 redirects, :443 terminates TLS)
    | HTTP and WebSocket on the Compose network
    v
FastAPI  ----> PostgreSQL
```

The proxy forwards `/api/...` requests to FastAPI and upgrades
`/ws/transcribe` for live transcription. FastAPI's existing session-cookie and
WebSocket `Origin` checks remain the only authentication boundary; the proxy
does not add a second login mechanism. Faster-Whisper remains CPU/int8 and the
LLM remains an external OpenAI-compatible provider.

## Configuration

Copy the checked-in example, then replace every `CHANGE_ME` value with a real
secret or provider setting. Do not commit the resulting file.

```bash
cd backend
cp .env.production.example .env.production
```

Set these public deployment values consistently:

- `PUBLIC_HOST` is the DNS name handled by this proxy, for example
  `app.example.com`.
- `REMOTE_CORS_ORIGINS` contains the exact PWA origin, for example
  `https://app.example.com`. It must have the same scheme, host, and optional
  port that the browser sends in its `Origin` header.
- `VITE_BACKEND_URL` in the separately built PWA is `https://PUBLIC_HOST`.
  The existing frontend derives `wss://PUBLIC_HOST/ws/transcribe`
  automatically; do not expose a separate WebSocket URL unless a deployment
  truly needs one.

Required secret values are:

- `POSTGRES_PASSWORD`
- `POSTGRES_DATABASE_URL` (which contains the database password)
- `AUTH_SESSION_SECRET` (at least 32 characters)
- `LLM_API_KEY`, only when the selected provider requires one

`APP_ENV=production` makes backend startup fail fast unless PostgreSQL storage,
remote authentication, a strong session secret, secure cookies, and at least
one exact `REMOTE_CORS_ORIGINS` entry are configured. Keep
`AUTH_COOKIE_SECURE=1`: the browser sends the HTTP-only, SameSite=Lax session
cookie over HTTPS and presents it to the WSS upgrade on the same host.

The supplied compose file uses `database` as its PostgreSQL hostname. For an
externally managed PostgreSQL service, replace `POSTGRES_DATABASE_URL` with its
TLS-capable connection string and omit the local database service if
appropriate.

## TLS certificate files

Before starting the stack, place deployment-provided certificate material in a
local `backend/certs/` directory:

```text
backend/certs/tls.crt
backend/certs/tls.key
```

The proxy mounts that directory read-only at `/etc/nginx/certs`. The names in
the Nginx configuration deliberately contain no real domain or certificate
authority. The directory is ignored by Git and excluded from the backend image
build context; never add private keys, certificate archives, or ACME account
data to source control.

Obtain and renew certificates using the deployment platform or your chosen
external certificate mechanism. Confirm the certificate's subject/SAN covers
`PUBLIC_HOST` before publishing DNS or exposing the host.

## Start the stack

```bash
cd backend
docker compose --env-file .env.production -f compose.production.yml up --build
```

Only Nginx publishes host ports: HTTP `80` redirects to HTTPS `443`. FastAPI
and PostgreSQL have no host port mappings and communicate only through the
internal Compose network. PostgreSQL data is stored in `postgres_data` and
downloaded Whisper model files are stored in `backend_model_cache`; neither is
removed by a normal `docker compose down`.

Nginx proxies normal REST traffic as:

```text
https://PUBLIC_HOST/api/... -> proxy -> http://backend:8000/api/...
```

and live transcription as:

```text
wss://PUBLIC_HOST/ws/transcribe -> proxy WebSocket upgrade -> ws://backend:8000/ws/transcribe
```

The proxy passes standard forwarding headers and leaves browser `Origin` and
cookie headers intact for FastAPI's existing checks. It allows a 256 MiB audio
file plus small multipart overhead, uses a short upstream connect timeout, and
allows long reads/sends for live transcription. WebSocket request/response
buffering is disabled. The application still enforces its own upload and live
audio limits.

Build and host the PWA static files through the same HTTPS origin or a properly
configured public frontend host. If it is a different origin, add that exact
origin to `REMOTE_CORS_ORIGINS` and validate the browser cookie behavior before
release. This Compose file intentionally does not add a frontend image or
static-file server.

## Health endpoints

- `GET /api/health` is a liveness response with no configuration details.
- `GET /api/ready` returns `200` only after model and storage startup complete;
  it is also used by the FastAPI container health check.
- `GET /api/status` remains the safe desktop compatibility status endpoint.

Use the HTTPS endpoint through the proxy for external readiness checks. If
PostgreSQL is unavailable at startup, FastAPI never becomes ready and Docker
restarts it according to the Compose policy.

## Proxy security and privacy baseline

The HTTPS virtual host sends HSTS, `X-Content-Type-Options: nosniff`, a strict
cross-origin referrer policy, and `X-Frame-Options: DENY`. These headers apply
only after TLS is active and do not alter FastAPI authentication, CORS, or
WebSocket protocol handling.

Nginx access logs deliberately use `$uri`, which excludes query strings. They
record only client address, status, response size, request method/path, and
duration. They do not log request query text, cookies, Authorization headers,
request bodies, audio, transcripts, API keys, or session identifiers. Avoid
adding `$request`, `$request_uri`, `$args`, cookie variables, or request-header
variables to the proxy log format.

This phase sets an upload-size baseline only. Apply deployment-platform rate
limits, WAF policy, backups, secret management, monitoring, and certificate
automation once the actual hosting environment is selected.

## Not included

This repository does not perform public deployment, DNS configuration,
certificate issuance/renewal, managed secrets, rate limiting, backups,
monitoring, or static PWA hosting. Those decisions remain for Phase 7J-4 and
the target deployment environment.
