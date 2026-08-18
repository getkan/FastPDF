# FastPDF

FastPDF is a TypeScript service that renders HTML to PDF in a headless Chromium browser and returns the PDF binary directly in the HTTP response.

## What it does today

- Accepts HTML and renders it to PDF synchronously.
- Exposes an authentication endpoint at /authenticate that returns a JWT.
- Protects the /pdf-render route with JWT verification.
- Returns PDF bytes with application/pdf content type.
- Includes health checks, request ID propagation, rate limiting, and optional Sentry telemetry.

## Current stack

- Fastify for the HTTP API
- TypeScript for typed request/response handling
- Puppeteer + Chromium for PDF generation
- Zod for request validation
- Pino for structured logging
- Sentry exception reporting with structured local logs
- k6 load tests with shared HTML fixture helpers in [load-test/shared.js](load-test/shared.js)

## API endpoints

### POST /authenticate

Request body:

```json
{
  "password": "your-shared-password"
}
```

Response:

```json
{
  "success": true,
  "token": "<jwt>",
  "tokenType": "Bearer"
}
```

### POST /pdf-render

Requires a Bearer token from /authenticate.

Request body:

```json
{
  "html": "<html><body><h1>Hello</h1></body></html>",
  "filename": "document"
}
```

Response:
- Status: 200
- Content-Type: application/pdf
- Body: raw PDF bytes

### GET /health

Returns basic health information and uptime.

## Run locally without Docker

1. Install dependencies:

```bash
npm install
```

2. Create a local environment file:

```bash
cp .env.example .env
```

3. Update the values in .env before starting the service. At minimum, set strong values for AUTH_PASSWORD and JWT_SECRET.

4. Start the API:

```bash
npm run dev
```

5. Test the endpoints with the request collection in [api.http](api.http), or with curl:

```bash
curl http://localhost:2626/health
```

### Save a test PDF to tmp

Use the helper script to authenticate and write a rendered PDF file to `tmp/local-test.pdf`:

```bash
chmod +x scripts/render-local-pdf.sh
./scripts/render-local-pdf.sh
```

The script reads `AUTH_PASSWORD` from your local `.env` file.

Optional flags:

```bash
./scripts/render-local-pdf.sh -u http://localhost:1234 -o ./tmp/my-report.pdf -f my-report
```

## Run with Docker

1. Build the image:

```bash
docker build -t fast-pdf .
```

2. Run the container and expose the service on port 2626:

```bash
docker run --rm -p 2626:2626 --env-file .env fast-pdf
```

3. Verify the service is healthy:

```bash
curl http://localhost:2626/health
```

## Tests

```bash
npm run test
```

### Verify Sentry exception reporting

Run this from the `FastPDF` directory with a valid `SENTRY_DSN` in `.env`:

```bash
npm run test:sentry
```

This deliberately sends one exception named `FastPDF Sentry smoke test failure` and waits for the Sentry client to flush it. The command prints the Sentry event ID; use that ID or the exception name to find the event in the configured Sentry project. The stack trace printed locally is expected and comes from the local structured error log.

Do not run this repeatedly in production. It creates a real Sentry issue event.

### k6 stress tests with HTML fixtures

You can run the stress tests against multiple real HTML fixtures instead of the built-in sample payload.

Set these environment variables when running `load-test/stress.js`, `load-test/baseline.js`, or `load-test/auth-and-render.js`:

- `HTML_FIXTURES_DIR`: folder that contains your HTML files
- `HTML_FIXTURE_FILES`: comma-separated file names (or paths) to load

The scripts share fixture-loading and header helpers from [load-test/shared.js](load-test/shared.js).

Example:

```bash
k6 run \
  -e BASE_URL=http://localhost:2626 \
  -e AUTH_PASSWORD=your-password \
  -e HTML_FIXTURES_DIR=./tmp/html \
  -e HTML_FIXTURE_FILES=apex-report-finance.html,apex-report-operations.html,apex-report-sales.html \
  load-test/stress.js
```

## Environment variables

FastPDF reads configuration from `.env` at startup.
Copy from `.env.example`, then adjust values for your environment.

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | No | `development` | Runtime mode. Allowed values: `development`, `production`, `test`. |
| `PORT` | No | `2626` | Port for the HTTP server. |
| `HOST` | No | `0.0.0.0` | Host/interface the server binds to. |
| `LOG_LEVEL` | No | `info` | Log verbosity. Allowed values: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `AUTH_PASSWORD` | Yes | none | Shared password used by `POST /authenticate`. Must be at least 16 characters. |
| `JWT_SECRET` | Yes | none | Secret used to sign JWTs. Must be at least 32 characters. |
| `JWT_EXPIRES_IN` | No | `1d` | JWT expiry window. |
| `MAX_HTML_SIZE` | No | `5242880` | Maximum accepted HTML payload size in bytes. |
| `CONCURRENT_RENDERS` | No | `5` | Maximum number of concurrent PDF render jobs. |
| `RATE_LIMIT_MAX` | No | `60` | Maximum number of requests allowed per rate-limit window per client. |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Rate-limit window size in milliseconds. |
| `PUPPETEER_EXECUTABLE_PATH` | No | auto-detected | Optional path to a Chrome/Chromium binary. Leave empty unless you need an override. |
| `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` | No | `false` | Controls Chromium download behavior during Puppeteer install/build workflows. |
| `SENTRY_DSN` | No | empty | Optional Sentry DSN for errors and unhandled exceptions. |

Notes:
- `AUTH_PASSWORD` and `JWT_SECRET` must be set to strong values before startup.
- Leave `SENTRY_DSN` empty when Sentry error reporting is not needed.
- Do not commit real secrets from `.env`.

## Project layout

```text
src/
  app.ts
  env.ts
  server.ts
  sentry.ts
  modules/
    auth/
    pdf-render/
  shared/
load-test/
  shared.js
```

## Documentation

Current docs in this repo focus on the implemented service and production hardening:

- [docs/ARCHITECTURE_DIAGRAM.md](docs/ARCHITECTURE_DIAGRAM.md)
- [docs/PRODUCTION_READINESS_GUIDE.md](docs/PRODUCTION_READINESS_GUIDE.md)
- [docs/REFERENCE_GUIDE.md](docs/REFERENCE_GUIDE.md)

For deployment and production hardening details, see [docs/PRODUCTION_READINESS_GUIDE.md](docs/PRODUCTION_READINESS_GUIDE.md).
