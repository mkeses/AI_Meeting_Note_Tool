# Production Deployment Runbook

This runbook deploys the authenticated React PWA, FastAPI backend, PostgreSQL,
and Nginx HTTPS/WSS edge on one Docker-capable machine. It does not provision
DNS, issue certificates, manage secrets, provide backups, or deploy cloud
infrastructure.

## 1. Prerequisites

The production machine needs:

- Docker Engine or Docker Desktop with the Docker Compose plugin (`docker
  compose`).
- A DNS name that can point to the machine.
- Inbound TCP ports `80` and `443` available to Nginx.
- A TLS certificate and private key whose subject/SAN covers `PUBLIC_HOST`.
- Network access from the backend container to PostgreSQL and the configured
  LLM provider.

The production backend runs Faster-Whisper with CPU/int8. This repository does
not define a CPU, memory, or storage recommendation; size the machine for the
selected Whisper model, expected concurrent work, PostgreSQL data, and Docker's
model cache.

## 2. Obtain the source

On the deployment machine, clone the repository and enter the production
configuration directory:

```bash
git clone https://github.com/mkeses/AI_Meeting_Note_Tool.git
cd AI_Meeting_Note_Tool/backend
```

Use the release or branch approved for the deployment. Do not place `.env`
files, certificates, private keys, recordings, or transcripts in Git.

## 3. DNS and TLS

Choose the public hostname, for example `app.example.com`, and create an `A`
record pointing that hostname to the server's public IPv4 address. Add an
`AAAA` record only when the server is intentionally reachable over IPv6. A
`CNAME` may be used instead when the DNS provider or hosting arrangement
requires it. Verify that the hostname resolves to the intended server before
requesting or installing a certificate.

The current Nginx configuration expects deployment-provided files at:

```text
backend/certs/tls.crt
backend/certs/tls.key
```

Prepare them before starting the stack:

```bash
mkdir -p certs
cp /path/to/issued-certificate.pem certs/tls.crt
cp /path/to/private-key.pem certs/tls.key
chmod 600 certs/tls.key
```

The Compose stack mounts `certs/` read-only at `/etc/nginx/certs`. Nginx listens
on port `80` only to redirect requests to HTTPS, and terminates TLS on port
`443`. Certificate issuance and renewal automation are not implemented here;
use the certificate authority or deployment platform's external renewal
process, then safely replace the mounted files and restart the proxy.

HTTPS is required for normal PWA installation and browser microphone access.
Browser live transcription uses WSS through the same HTTPS origin.

## 4. Configure production variables and secrets

Create the deployment environment file from the checked-in example:

```bash
cp .env.production.example .env.production
```

Edit `.env.production` and replace every `CHANGE_ME` value. The file is used
both for Compose interpolation and as the backend container's `env_file`.

For the shell commands below, either replace `$PUBLIC_HOST` with the configured
hostname or export that non-secret value first, for example:

```bash
export PUBLIC_HOST=app.example.com
```

Required Compose variables:

| Variable | Purpose | Secret? |
| --- | --- | --- |
| `PUBLIC_HOST` | Hostname rendered into the Nginx virtual host. | No |
| `POSTGRES_DB` | Database name created by the bundled PostgreSQL image. | No |
| `POSTGRES_USER` | Database user created by the bundled PostgreSQL image. | No |
| `POSTGRES_PASSWORD` | Password for that PostgreSQL user. | Yes |

Required backend variables:

| Variable | Purpose | Secret? |
| --- | --- | --- |
| `APP_ENV=production` | Enables production fail-fast validation. | No |
| `MEETING_STORAGE_BACKEND=postgresql` | Selects the remote storage implementation. | No |
| `POSTGRES_DATABASE_URL` | PostgreSQL connection URL, including database name. | Yes; may contain the DB password |
| `AUTH_ENABLED=1` | Enables authenticated remote workspace behavior. | No |
| `AUTH_SESSION_SECRET` | Signs sessions/CSRF tokens; use at least 32 random characters. | Yes |
| `AUTH_COOKIE_SECURE=1` | Restricts the session cookie to HTTPS. | No |
| `REMOTE_CORS_ORIGINS` | Exact browser origin, such as `https://app.example.com`. | No |
| `WHISPER_MODEL` | Faster-Whisper model name, such as `base.en`. | No |
| `LLM_BASE_URL` | OpenAI-compatible provider endpoint. | Usually no; avoid credentials in the URL |
| `LLM_MODEL` | Provider model name. | No |

Optional backend variables:

- `LLM_API_KEY`: provider key. It may be omitted for a local Ollama-compatible
  provider, but is required by providers that require authentication.
- `LLM_TIMEOUT_SECONDS`: LLM timeout in seconds; defaults to `30`.
- `AUTH_SESSION_LIFETIME_SECONDS`: session lifetime in seconds; defaults to
  `86400`.
- `AUTH_COOKIE_NAME`: session-cookie name; defaults to
  `ai_meeting_session`.

`POSTGRES_DATABASE_URL` must use `postgres://` or `postgresql://` and name a
database in production. PostgreSQL TLS parameters already supported by the
driver may be included in the URL, for example `?sslmode=require` or
`sslmode=verify-full&sslrootcert=/path/to/ca.pem` when the CA is available to
the backend container.

The same-origin PWA needs no frontend backend URL. The production Compose build
leaves `VITE_BACKEND_URL` empty, so browser REST and WSS use the public origin.
If the PWA is intentionally built for another backend origin, set the optional
Compose build variable `VITE_BACKEND_URL` in `.env.production`; Compose passes
it only as a frontend build argument. `VITE_WS_URL` is also supported by the
frontend for an intentionally separate WebSocket base URL, but is not needed
for this stack. `VITE_BACKEND_PORT` is a local browser-development setting, not
a production setting.

## 5. PostgreSQL and persistence

The bundled Compose stack starts `postgres:16-alpine` as the `database` service.
Its health check uses `pg_isready`; FastAPI waits for that health check before
starting the backend container. PostgreSQL data is stored in the named
`postgres_data` volume. The backend model cache is stored in the named
`backend_model_cache` volume.

FastAPI initializes the schema idempotently during startup. A database
initialization failure prevents `/api/ready` from becoming ready and causes
Compose's restart policy to restart the backend. Runtime storage failures are
returned as controlled `503` responses without connection details.

An externally managed PostgreSQL instance is supported: set
`POSTGRES_DATABASE_URL` to its reachable connection URL and remove or replace
the bundled `database` service as appropriate for that deployment. The
application applies a ten-second PostgreSQL connection timeout. Configure the
provider's required TLS parameters in the URL.

There is currently no dedicated migration framework. Schema initialization is
idempotent and remains appropriate until incompatible schema changes require a
migration system. Do not use this deployment procedure as a substitute for
planned schema migration review.

## 6. LLM provider

Local development commonly uses Ollama:

```env
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=gemma3:4b
```

The API-key value above is only a local SDK placeholder; `Settings` permits it
to be omitted and the provider uses its safe Ollama placeholder internally.
The production stack does not start Ollama. Configure `LLM_BASE_URL`,
`LLM_MODEL`, and, when required, `LLM_API_KEY` for a reachable production
OpenAI-compatible provider.

Provider connection and request calls use `LLM_TIMEOUT_SECONDS`, which defaults
to 30 seconds. Provider failures become safe application errors. If cleanup
fails, the raw Whisper transcription remains available; cleanup failure does
not erase the transcript. Provider URLs, keys, prompts, and responses are not
returned by the status endpoint or written to the normal application logs.

## 7. Build and start the stack

From `backend/`, first validate Compose interpolation and file references:

```bash
docker compose --env-file .env.production -f compose.production.yml config
```

Build the production backend and PWA images, then start in the background:

```bash
docker compose --env-file .env.production -f compose.production.yml up --build -d
```

The backend image uses `backend/Dockerfile.production`. The proxy image uses
`frontend/Dockerfile.production`, which runs `npm run build:pwa` and serves the
resulting files from `/usr/share/nginx/html`. Only Nginx publishes host ports;
FastAPI and PostgreSQL remain on the internal Compose network.

Inspect service state and logs:

```bash
docker compose --env-file .env.production -f compose.production.yml ps
docker compose --env-file .env.production -f compose.production.yml logs --tail=200 proxy backend database
docker compose --env-file .env.production -f compose.production.yml logs -f proxy backend
```

Check the public health and readiness endpoints over HTTPS:

```bash
curl -fsS https://$PUBLIC_HOST/api/health
curl -fsS https://$PUBLIC_HOST/api/ready
```

Expected responses are `{"status":"alive"}` and `{"status":"ready"}`.
`/api/ready` becomes ready only after the required application services,
storage, and remote authentication store initialize.

Restart without rebuilding:

```bash
docker compose --env-file .env.production -f compose.production.yml restart
```

Stop the stack while retaining named volumes:

```bash
docker compose --env-file .env.production -f compose.production.yml down
```

Do not use `docker compose down -v` unless intentionally deleting the
PostgreSQL and model-cache volumes.

## 8. Request routing

The normal production browser origin is one HTTPS origin:

```text
https://PUBLIC_HOST/
    -> Nginx -> PWA static files / SPA fallback

https://PUBLIC_HOST/api/...
    -> Nginx -> http://backend:8000/api/...

wss://PUBLIC_HOST/ws/transcribe
    -> Nginx WebSocket upgrade -> ws://backend:8000/ws/transcribe

FastAPI
    -> PostgreSQL and configured LLM provider
```

The Nginx `/api` and `/ws` locations take precedence over the general SPA
location, so backend requests are not swallowed by `index.html`. FastAPI and
PostgreSQL have no published host ports in the production Compose file. Nginx
is the public HTTPS boundary and preserves the browser Origin and session
cookie for FastAPI's authentication checks.

## 9. PWA behavior

The production frontend is built with:

```bash
cd frontend
npm ci
npm run build:pwa
```

The production Docker build performs these steps automatically. `build:pwa`
uses root-relative assets so routes such as `/login` work through Nginx's SPA
fallback. The ordinary `npm run build` remains the relative-asset build used
by Electron.

The PWA manifest is served from `/manifest.webmanifest`. The service worker
caches the application shell, manifest/icon, and Vite `/assets/` resources.
Entry points and the service worker revalidate; hashed assets can use long
immutable cache lifetimes.

The service worker does not handle or cache `/api/*`, `/ws/*`, authentication
responses, CSRF tokens, meeting data, transcripts, audio, cleanup responses,
credentials, or secrets. There is no offline synchronization. Authenticated
dynamic data remains dependent on the live HTTPS/API connection.

## 10. Security and operational controls

The current implementation provides:

- HttpOnly, SameSite session-cookie authentication for remote mode.
- Signed CSRF tokens for REST state-changing requests.
- Exact allowed-Origin validation for remote WebSocket handshakes.
- WebSocket limits of 16 KiB for control messages, 1 MiB per audio frame, and
  256 MiB of buffered authenticated live audio.
- A 256 MiB application audio-upload limit. Nginx permits the corresponding
  257 MiB multipart request limit only on `/api/transcribe`; other API routes
  have a 4 MiB request-body limit.
- Validation limits for cleanup/meeting text, custom cleanup prompts, meeting
  notes, and search parameters.
- A production-only, bounded process-local authentication limiter: five
  registration attempts or failed login attempts per client/endpoint per
  60-second window. The sixth attempt receives `429` and `Retry-After`.
  Successful login clears that login's failed-attempt state. It is not a
  distributed limiter and is suitable only for this single-instance stack.
- PostgreSQL URL validation, a ten-second PostgreSQL connect timeout, and safe
  storage/provider error responses.
- LLM request timeouts and raw-transcript preservation when cleanup fails.
- `/api/health` as a cheap liveness endpoint, `/api/ready` as the dependency
  readiness endpoint, and `/api/status` as the existing safe compatibility
  endpoint without provider secrets.
- Uvicorn graceful shutdown configured for 30 seconds and a 45-second Compose
  backend stop grace period. Active WebSocket transcription tasks are canceled
  through the existing handler cleanup path.
- Privacy-conscious application and Nginx logs. They do not log passwords,
  session/CSRF tokens, API keys, cookies, authorization headers, request
  bodies, transcripts, uploaded audio, LLM URLs, or database connection
  strings. Nginx access logs omit query strings.

## 11. Backups and data recovery

The `postgres_data` Docker volume provides persistence across normal container
recreation and `docker compose down` followed by `up`. It is not a disaster-
recovery backup: loss of the host, volume, or storage can still lose meetings.

No backup infrastructure is included. Establish an operational PostgreSQL
backup, restore-test, retention, and off-host storage strategy before relying
on this deployment. For a serious deployment, managed PostgreSQL backup and
point-in-time recovery facilities may be preferable. Do not delete volumes as
part of routine updates.

## 12. Updating an existing deployment

The current Compose procedure is a simple downtime update, not zero-downtime
deployment:

```bash
cd AI_Meeting_Note_Tool/backend
git pull --ff-only
docker compose --env-file .env.production -f compose.production.yml up --build -d
docker compose --env-file .env.production -f compose.production.yml ps
curl -fsS https://$PUBLIC_HOST/api/ready
```

Review the diff and environment changes before rebuilding. The named
PostgreSQL and model-cache volumes are retained. After readiness succeeds,
perform the authenticated browser/API/WebSocket smoke checks required by the
deployment process. Do not claim zero downtime or automatic rollback from
this procedure.

## 13. Troubleshooting

### DNS does not resolve

Verify the hostname and the server's public address from the deployment host:

```bash
getent hosts "$PUBLIC_HOST"
```

Correct the DNS `A`/`AAAA`/`CNAME` record and wait for propagation before
debugging TLS or Nginx.

### TLS certificate or HTTPS problem

Confirm the certificate files exist and the certificate covers `PUBLIC_HOST`:

```bash
ls -l certs/tls.crt certs/tls.key
openssl s_client -connect "$PUBLIC_HOST:443" -servername "$PUBLIC_HOST" </dev/null
```

Then inspect the proxy logs. Certificate issuance and renewal are external to
this repository.

### Nginx fails to start

Validate Compose configuration and inspect the proxy container:

```bash
docker compose --env-file .env.production -f compose.production.yml config
docker compose --env-file .env.production -f compose.production.yml logs proxy
```

Check `PUBLIC_HOST`, both certificate files, and port ownership on the host.

### PWA loads but API requests fail

Check the public health endpoint, proxy/backend logs, and readiness:

```bash
curl -fsS https://$PUBLIC_HOST/api/health
docker compose --env-file .env.production -f compose.production.yml logs --tail=200 proxy backend
```

Confirm that the PWA was built with `npm run build:pwa`, that the browser uses
the same HTTPS origin, and that the backend is ready.

### WebSocket or live transcription fails

Confirm HTTPS/WSS access, backend readiness, proxy logs, and the exact
`REMOTE_CORS_ORIGINS` value. The browser must send the authenticated session
cookie and an allowed Origin; WSS does not bypass those checks. Also check the
existing WebSocket frame and buffered-audio limits in the operational controls
above.

### PostgreSQL is not ready

Inspect service state and both database/backend logs:

```bash
docker compose --env-file .env.production -f compose.production.yml ps
docker compose --env-file .env.production -f compose.production.yml logs --tail=200 database backend
```

Check the bundled `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, and
`POSTGRES_DATABASE_URL` values. Do not remove `postgres_data` to troubleshoot
an ordinary startup failure.

### LLM cleanup is unavailable

Check backend logs and verify that `LLM_BASE_URL` is reachable from the backend
container, `LLM_MODEL` exists at that provider, and `LLM_API_KEY` is present
when required. The `/api/ready` endpoint does not perform an expensive LLM
request; provider availability is reported when cleanup is attempted. Raw
transcription remains available when cleanup fails.

### Authentication or CSRF fails

Use the exact HTTPS PWA origin in `REMOTE_CORS_ORIGINS`, keep
`AUTH_COOKIE_SECURE=1`, and ensure the browser is not being tested over plain
HTTP. The frontend obtains the signed CSRF token from `/api/auth/csrf`; do not
place session or CSRF tokens in URLs or local storage.

### Readiness reports unavailable

Run the readiness request and inspect backend/database logs:

```bash
curl -i https://$PUBLIC_HOST/api/ready
docker compose --env-file .env.production -f compose.production.yml logs --tail=200 backend database
```

Readiness remains unavailable while models, storage, or the required remote
authentication store have not initialized.

### A frontend route returns an unexpected response

Confirm the proxy is serving the PWA image and that the request is not an API
or WebSocket path. The production PWA build uses root-relative assets and Nginx
serves non-file browser routes through `index.html`.

## Not included

This repository does not include public deployment automation, DNS management,
certificate issuance/renewal, managed secrets, distributed rate limiting,
monitoring, backups, disaster recovery, zero-downtime deployment, or rollback
automation. These are required operational decisions for the real deployment
machine and Phase 7J-9 smoke test.
