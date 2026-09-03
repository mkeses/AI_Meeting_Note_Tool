# Production Remote Stack

This repository provides a production deployment foundation for the remote
application: an Nginx HTTPS/WSS edge, a static React PWA, FastAPI, and
PostgreSQL. It does not deploy a public host, provision DNS, or issue or renew
certificates.

```text
Browser/PWA
    | HTTPS and WSS
    v
Nginx (:80 redirects, :443 terminates TLS)
    | serves PWA      | HTTP and WebSocket on the Compose network
    v                 v
React PWA         FastAPI  ----> PostgreSQL
```

The proxy serves the PWA and forwards `/api/...` requests to FastAPI, while
upgrading `/ws/...` for live transcription. FastAPI's existing session-cookie
and WebSocket `Origin` checks remain the only authentication boundary; the
proxy does not add a second login mechanism. Faster-Whisper remains CPU/int8
and the LLM remains an external OpenAI-compatible provider.

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
- The supplied PWA build leaves `VITE_BACKEND_URL` unset and uses its own
  HTTPS origin for `/api/...` and `/ws/transcribe`. Set it only when the PWA
  is intentionally hosted on a different origin. The existing frontend then
  derives `wss://PUBLIC_HOST/ws/transcribe` automatically; do not expose a
  separate WebSocket URL unless a deployment truly needs one. When needed,
  set `VITE_BACKEND_URL` in `.env.production`; Compose passes it only as a
  frontend build argument, never to FastAPI.

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

Remote REST mutations also require an `X-CSRF-Token` header. The PWA obtains a
short-lived signed token from `GET /api/auth/csrf` after it discovers remote
authentication, then supplies it for registration, login, logout, meeting
changes, cleanup, and audio upload. The token is never placed in a URL or
persisted in browser storage. Local and Electron mode have authentication
disabled, so they do not request or require CSRF tokens. WebSockets remain
protected by their existing authenticated session cookie and exact Origin
check rather than by the REST token.

The supplied compose file uses `database` as its PostgreSQL hostname. For an
externally managed PostgreSQL service, replace `POSTGRES_DATABASE_URL` with its
TLS-capable connection string and omit the local database service if
appropriate.

Production accepts only `postgres://` or `postgresql://` connection URLs that
name a database; SQLite URLs and malformed values fail before application
startup. The bundled Compose database uses the internal `database` hostname.
For a managed database, supply its hostname in the same variable instead. Use
the provider's required TLS parameters, such as `?sslmode=require`, or
`sslmode=verify-full` with a CA certificate made available to the backend. Do
not add TLS requirements to the bundled URL unless the bundled database is
configured for them.

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

The proxy image builds the frontend with `npm run build:pwa`, then serves the
resulting static files from `/usr/share/nginx/html`. This PWA build uses
root-relative assets for SPA routes such as `/login`; the existing `npm run
build` remains the relative-asset Electron build.

Only Nginx publishes host ports: HTTP `80` redirects to HTTPS `443`. FastAPI
and PostgreSQL have no host port mappings and communicate only through the
internal Compose network. PostgreSQL data is stored in `postgres_data` and
downloaded Whisper model files are stored in `backend_model_cache`; neither is
removed by a normal `docker compose down`.

The database schema initialization is currently idempotent and runs during
FastAPI startup after PostgreSQL passes `pg_isready`. A database startup failure
prevents the backend container from becoming ready, so Docker restarts it under
the existing policy. This is not a substitute for schema migrations or backups:
no backup automation is included, and a migration process should be introduced
before future incompatible schema changes.

Nginx proxies normal REST traffic as:

```text
https://PUBLIC_HOST/api/... -> proxy -> http://backend:8000/api/...
```

and live transcription as:

```text
wss://PUBLIC_HOST/ws/transcribe -> proxy WebSocket upgrade -> ws://backend:8000/ws/transcribe
```

All other browser routes use Nginx's SPA fallback to `index.html`. API and
WebSocket locations take precedence, so neither is served by that fallback.
Hashed `/assets/` files receive long immutable cache headers; `index.html`, the
manifest, and service worker revalidate. The service worker only caches the
app shell and static assets. It never handles `/api/` or `/ws/` requests, so it
does not cache sessions, CSRF tokens, meetings, transcript data, cleanup
requests, or audio uploads.

The proxy passes standard forwarding headers and leaves browser `Origin` and
cookie headers intact for FastAPI's existing checks. It allows a 256 MiB audio
file plus small multipart overhead, uses a short upstream connect timeout, and
allows long reads/sends for live transcription. WebSocket request/response
buffering is disabled. The application still enforces its own upload and live
audio limits.

The supplied stack hosts the PWA through the same HTTPS origin. If deploying a
separate frontend host instead, add that exact origin to `REMOTE_CORS_ORIGINS`
and validate browser cookie behavior before release.

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
certificate issuance/renewal, managed secrets, rate limiting, backups, or
monitoring. Those decisions remain with the target deployment environment.
