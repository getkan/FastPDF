# FastPDF — Production Readiness Guide

Target deployment:
- **Local dev**: Docker container inside Laravel Sail (`docker-compose.yml`)
- **Production**: Two independent web servers managed by Laravel Forge, each running the FastPDF container
- **Observability**: Sentry errors and unhandled exceptions plus local structured logs
- **Load testing**: k6-based load test suite

---

## Remaining Dev Tasks (quick reference)

| # | Task | File(s) | Priority |
|---|------|---------|----------|
| 1 | Expand unit/integration test coverage | `test/test.ts` | 🟡 Medium |
| 2 | Tighten response sanitization | `src/modules/pdf-render/pdf-render.controller.ts` | 🟡 Medium |
| 3 | Consider a browser pool if load tests show saturation | `src/modules/pdf-render/pdf-render.service.ts` | 🟠 Low |

Most of the original roadmap items in this guide have now been implemented in code.

---

## Step 1 — Fix TypeScript / Module Config

**Problem**: The project is built as CommonJS output and the runtime entrypoint is `dist/server.js`.

**Fix**: Keep the current CommonJS build path unless you intentionally migrate the whole app to ESM.

```jsonc
// package.json — current build remains CommonJS
```

After the change, verify with:

```bash
npm run build && node dist/server.js
```

---

## Step 2 — Add Startup Environment Validation

Create `src/env.ts` to validate all required environment variables before the server starts:

The current implementation also normalizes env values, strips inline comments, and treats `SENTRY_DSN=null` or `undefined` as unset.

```typescript
// src/env.ts
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(2626),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  AUTH_PASSWORD: z.string().min(16, 'AUTH_PASSWORD must be at least 16 characters'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('1d'),
  MAX_HTML_SIZE: z.coerce.number().default(5 * 1024 * 1024),
  PUPPETEER_EXECUTABLE_PATH: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().default('fast-pdf'),
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1.0),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  CONCURRENT_RENDERS: z.coerce.number().int().min(1).max(50).default(5),
});

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(): Env {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment configuration:');
    result.error.issues.forEach(issue => {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    });
    process.exit(1);
  }
  return result.data;
}
```

Import and call at the top of `src/server.ts`:

```typescript
import { validateEnv } from './env.js';
const env = validateEnv(); // exits with helpful message if invalid
```

---

## Step 3 — Add OpenTelemetry (Sentry OTLP)

### 3a. Install dependencies

```bash
npm install @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-metrics-otlp-http \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions \
  @opentelemetry/sdk-metrics
```

### 3b. Create `src/telemetry.ts`

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

export function initTelemetry(serviceName: string, version = '1.0.0'): void {
    const sentryDsn = process.env.SENTRY_DSN;
    if (!sentryDsn) return;

    // Sentry OTLP endpoint: https://o<org>.ingest.sentry.io/api/<project>/integration/otlp
    const url = new URL(sentryDsn);
    const orgId = url.hostname.split('.')[0].replace('o', '');
    const projectId = url.pathname.split('/').pop();
    const sentryOtlpEndpoint = `https://o${orgId}.ingest.sentry.io/api/${projectId}/integration/otlp`;

    sdk = new NodeSDK({
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: serviceName,
            [ATTR_SERVICE_VERSION]: version,
        }),
        traceExporter: new OTLPTraceExporter({
            url: `${sentryOtlpEndpoint}/v1/traces`,
            headers: {
                'x-sentry-auth': `sentry sentry_key=${url.username}, sentry_version=7`,
            },
        }),
        metricReader: new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({
                url: `${sentryOtlpEndpoint}/v1/metrics`,
                headers: {
                    'x-sentry-auth': `sentry sentry_key=${url.username}, sentry_version=7`,
                },
            }),
            exportIntervalMillis: 15_000,
        }),
        instrumentations: [
            getNodeAutoInstrumentations({
                '@opentelemetry/instrumentation-fs': { enabled: false },
            }),
        ],
    });

    sdk.start();
}

export async function shutdownTelemetry(): Promise<void> {
    if (sdk) {
        await sdk.shutdown();
    }
}
```

### 3c. Initialise before anything else in `src/server.ts`

OTel should initialize before the app starts so Node instrumentation is ready early:

```typescript
import 'dotenv/config';
import { initTelemetry } from './telemetry.js';

initTelemetry(process.env.OTEL_SERVICE_NAME ?? 'fast-pdf');
// ... rest of server.ts
```

### 3d. Add manual span around PDF render

`src/modules/pdf-render/pdf-render.service.ts` already wraps `renderHTML()` in a span for per-request visibility:

```typescript
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('fast-pdf.pdf-render');

async renderHTML(request: RenderRequest): Promise<Buffer> {
  return tracer.startActiveSpan('pdf.render', async (span) => {
    span.setAttributes({
      'pdf.format': request.options?.format ?? 'letter',
      'html.size_bytes': Buffer.byteLength(request.html),
    });
    try {
      // ... existing render logic ...
      span.setStatus({ code: SpanStatusCode.OK });
      return buffer;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}
```

### 3e. Enrich the `/health` endpoint

The health route already returns structured JSON with status, timestamp, uptime, and memory.

```typescript
// In health route handler
fastify.get('/health', async (_, reply) => {
  return reply.send({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});
```

### 3f. Sentry OTLP Configuration

Sentry provides an OTLP-compatible endpoint for traces and metrics. To use it:

1. **Get your Sentry DSN** from: Sentry → Project Settings → Client Keys (DSN)
   - Format: `https://<key>@o<org>.ingest.sentry.io/<project>`

2. **Set environment variables**:
   ```dotenv
   SENTRY_DSN=https://<key>@o<org>.ingest.sentry.io/<project>
   SENTRY_TRACES_SAMPLE_RATE=1.0
   ```

3. **The telemetry module automatically**:
   - Parses the DSN to extract org ID and project ID
   - Constructs the OTLP endpoint: `https://o<org>.ingest.sentry.io/api/<project>/integration/otlp`
   - Adds the required `x-sentry-auth` header with your public key
   - Leaves telemetry disabled when `SENTRY_DSN` is blank

4. **Verify in Sentry**:
   - Traces appear under Performance → Traces
   - Metrics appear under Metrics (if enabled in your plan)
   - Errors are captured automatically via the OTel error instrumentation

---

## Step 4 — Harden the Dockerfile

Replace the current single-stage Dockerfile with a multi-stage build that:
- Uses Debian slim (Chromium deps are easier than Alpine)
- Runs as a non-root user
- Installs only production `node_modules`
- Includes a Docker health check

```dockerfile
# Stage 1: build
FROM node:24-slim AS builder
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: runtime
FROM node:24-slim AS runtime

# Chromium and its dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install prod deps only
COPY --from=builder /build/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output
COPY --from=builder /build/dist ./dist

# Non-root user
RUN useradd -m -u 10001 -s /bin/false fast-pdf
USER fast-pdf

ENV NODE_ENV=production \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 2626

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:2626/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
```

> **Note**: Set `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` in your `.env` / environment as well so Puppeteer uses the system Chromium.

Update `pdf-render.service.ts` to honour the env override:

```typescript
const browser = await puppeteer.launch({
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
```

---

## Step 5 — Expand Test Coverage

Add tests to `test/test.ts` for the critical paths:

1. **Auth — valid password** → receives JWT
2. **Auth — wrong password** → 401
3. **PDF render — valid HTML** → `application/pdf` response
4. **PDF render — no token** → 401
5. **PDF render — oversized body** → 413 or validation error
6. **Health endpoint** → returns JSON `{ status: 'ok' }`

Use the existing `setupApp()` pattern from the health check test. No external test framework is needed.

---

## Step 6 — Implement Load Tests

The docs specify a k6-based controller. Here is a practical minimal implementation to start.

The current repo already has [load-test/auth-and-render.js](../load-test/auth-and-render.js), [load-test/baseline.js](../load-test/baseline.js), [load-test/stress.js](../load-test/stress.js), and [load-test/shared.js](../load-test/shared.js).

### 6a. Install k6

```bash
# macOS
brew install k6
# or via Docker: docker run --rm -i grafana/k6 run -
```

### 6b. Create `load-test/auth-and-render.js`

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const renderDuration = new Trend('pdf_render_duration', true);
const renderErrors = new Counter('pdf_render_errors');

const BASE_URL = __ENV.BASE_URL || 'http://localhost:2626';
const PASSWORD = __ENV.AUTH_PASSWORD || 'changeme';

// Fixture HTML (small but realistic)
const HTML_FIXTURE = `<!DOCTYPE html><html><body>
  <h1>Invoice #{{VU}}</h1>
  <p>Generated at ${new Date().toISOString()}</p>
</body></html>`;

export const options = {
  scenarios: {
    baseline: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 5 },
        { duration: '1m',  target: 10 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    pdf_render_duration: ['p(95)<10000'], // 95th percentile under 10 s
    pdf_render_errors: ['count<5'],
    http_req_failed: ['rate<0.01'],       // <1% errors
  },
};

// Auth once per VU
export function setup() {
  const res = http.post(`${BASE_URL}/authenticate`, JSON.stringify({ password: PASSWORD }), {
    headers: { 'Content-Type': 'application/json' },
  });
  check(res, { 'auth ok': r => r.status === 200 });
  return { token: res.json('token') };
}

export default function (data) {
  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/pdf-render`,
    JSON.stringify({ html: HTML_FIXTURE.replace('{{VU}}', String(__VU)), filename: 'test.pdf' }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` },
      responseType: 'binary' }
  );

  renderDuration.add(Date.now() - start);

  const ok = check(res, {
    'render status 200': r => r.status === 200,
    'content-type is pdf': r => r.headers['Content-Type']?.includes('application/pdf'),
    'response non-empty': r => r.body.length > 1000,
  });

  if (!ok) renderErrors.add(1);

  sleep(1);
}
```

### 6c. Create `load-test/stress.js`

Reuse the same script with a higher VU count to find the breaking point:

```javascript
export const options = {
  scenarios: {
    stress: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '1m',  target: 20 },
        { duration: '2m',  target: 40 },
        { duration: '1m',  target: 60 },
        { duration: '30s', target: 0 },
      ],
    },
  },
};
// ... rest identical to auth-and-render.js
```

### 6d. Run commands

```bash
# Baseline against local Sail
k6 run -e BASE_URL=http://localhost:2626 -e AUTH_PASSWORD=yourpassword load-test/auth-and-render.js

# Stress against production (one server)
k6 run -e BASE_URL=https://pdf.yourdomain.com -e AUTH_PASSWORD=yourpassword load-test/stress.js

# JSON report for CI
k6 run --out json=load-test/runs/$(date +%Y%m%d-%H%M%S).json load-test/auth-and-render.js
```

Add `load-test/runs/` to `.gitignore`.

---

## Step 7 — Publish Docker Image To A Registry (With GitHub Actions)

Before wiring Laravel Sail and Forge, publish the FastPDF image to a registry and automate updates from GitHub.

### 7a. Create the registry repository

Pick one registry:

- **Docker Hub**: create `yourorg/fast-pdf`
- **GitHub Container Registry (GHCR)**: uses `ghcr.io/<owner>/fast-pdf`

### 7b. Add GitHub repository secrets

In GitHub -> your repository -> Settings -> Secrets and variables -> Actions, add:

- `DOCKER_USERNAME` (Docker Hub username, or GitHub username for GHCR)
- `DOCKER_TOKEN` (Docker Hub access token, or GitHub PAT with `write:packages` for GHCR)

### 7c. Add image publish workflow

Create `.github/workflows/publish-image.yml`:

```yaml
name: Publish Docker Image

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v5

      # Docker Hub login (recommended default)
      - name: Login to Docker Hub
        uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_TOKEN }}

      # GHCR login alternative (uncomment and update tags below)
      # - name: Login to GHCR
      #   uses: docker/login-action@v3
      #   with:
      #     registry: ghcr.io
      #     username: ${{ github.actor }}
      #     password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract Docker metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: yourorg/fast-pdf
          tags: |
            type=raw,value=latest
            type=sha

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

If you use GHCR, change `images:` to `ghcr.io/<owner>/fast-pdf` and use the GHCR login block.

### 7d. Verify the published image

After a push to `main`, confirm `latest` and a SHA tag are present in your registry:

```bash
docker pull yourorg/fast-pdf:latest
docker pull yourorg/fast-pdf:sha-<short-or-full-commit>
```

Use `latest` for simple pull-based deploys, and keep SHA tags for rollback safety.

---

## Step 8 — Local Laravel Sail Integration

### 8a. Add `.env` values to your Laravel project

```dotenv
FASTPDF_URL=http://fast-pdf:2626
FASTPDF_PASSWORD=a-strong-shared-secret-at-least-32-chars
FASTPDF_JWT_SECRET=another-strong-secret-at-least-32-chars
```

### 8b. Add the FastPDF service to `docker-compose.yml` (Sail)

#### Option 1: Build locally

```yaml
services:
  # ... your existing laravel.test service ...

  fast-pdf:
    build:
      context: ./services/fast-pdf   # path to a copy/clone of this repo
      dockerfile: Dockerfile
    ports:
      - '${FASTPDF_PORT:-2626}:2626'
    environment:
      NODE_ENV: production
      PORT: 2626
      HOST: 0.0.0.0
      LOG_LEVEL: info
      AUTH_PASSWORD: '${FASTPDF_PASSWORD}'
      JWT_SECRET: '${FASTPDF_JWT_SECRET}'
      JWT_EXPIRES_IN: 1d
      PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'true'
      PUPPETEER_EXECUTABLE_PATH: /usr/bin/chromium
      SENTRY_DSN: '${SENTRY_DSN}'
      SENTRY_TRACES_SAMPLE_RATE: 1.0
    networks:
      - sail
    restart: unless-stopped
    healthcheck:
      test: ['CMD', 'node', '-e', "require('http').get('http://localhost:2626/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 20s
```

#### Option 2: Pull from Docker Hub

```yaml
services:
  # ... your existing laravel.test service ...

  fast-pdf:
    image: surenick/fast-pdf:latest
    ports:
      - '${FASTPDF_PORT:-2626}:2626'
    environment:
      NODE_ENV: production
      PORT: 2626
      HOST: 0.0.0.0
      LOG_LEVEL: info
      AUTH_PASSWORD: '${FASTPDF_PASSWORD}'
      JWT_SECRET: '${FASTPDF_JWT_SECRET}'
      JWT_EXPIRES_IN: 1d
      PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'true'
      PUPPETEER_EXECUTABLE_PATH: /usr/bin/chromium
      SENTRY_DSN: '${SENTRY_DSN}'
      SENTRY_TRACES_SAMPLE_RATE: 1.0
    networks:
      - sail
    restart: unless-stopped
    healthcheck:
      test: ['CMD', 'node', '-e', "require('http').get('http://localhost:2626/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 20s
```

### 8c. Laravel HTTP client wrapper

Create `app/Services/FastPdfService.php`:

```php
<?php

namespace App\Services;

use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Cache;

class FastPdfService
{
    private string $baseUrl;
    private string $password;

    public function __construct()
    {
        $this->baseUrl = rtrim(config('services.fast-pdf.url'), '/');
        $this->password = config('services.fast-pdf.password');
    }

    public function render(string $html, array $options = []): string
    {
        $token = $this->getToken();

        $response = Http::withToken($token)
            ->timeout(60)
            ->post("{$this->baseUrl}/pdf-render", [
                'html'    => $html,
                'options' => $options,
            ]);

        if ($response->failed()) {
            throw new \RuntimeException("FastPDF render failed: {$response->status()}");
        }

        return $response->body();
    }

    private function getToken(): string
    {
        return Cache::remember('fast-pdf.token', now()->addHours(23), function () {
            $response = Http::post("{$this->baseUrl}/authenticate", [
                'password' => $this->password,
            ]);

            if ($response->failed()) {
                throw new \RuntimeException('FastPDF authentication failed');
            }

            return $response->json('token');
        });
    }
}
```

Add to `config/services.php`:

```php
'fast-pdf' => [
    'url'      => env('FASTPDF_URL', 'http://fast-pdf:2626'),
    'password' => env('FASTPDF_PASSWORD'),
],
```

---

## Step 9 — Laravel Forge Deployment (Two Servers)

### Architecture

```
Internet
  │
  └─▶  [DNS round-robin or upstream LB]
           ├─▶  Forge Server A  →  FastPDF container (port 2626)
           └─▶  Forge Server B  →  FastPDF container (port 2626)
```

Both servers are identical and independently healthy; the Laravel app talks to whichever resolves first, or you can configure a fixed primary + fallback in `FastPdfService`.

### 9a. Build and push the Docker image (manual fallback)

```bash
# From this repo root
docker build -t yourorg/fast-pdf:latest .
docker tag yourorg/fast-pdf:latest yourorg/fast-pdf:$(git rev-parse --short HEAD)

docker push yourorg/fast-pdf:latest
docker push yourorg/fast-pdf:$(git rev-parse --short HEAD)
```

Use Docker Hub, GHCR, or a private registry. Store credentials in Forge's environment manager.

### 9b. Forge site / daemon configuration

On each Forge server, create a **Daemon** (not a site) or use a **Docker-based site**:

**Option A — Docker daemon via Forge**

In the Forge panel → Server → Daemons → New Daemon:

```bash
docker run -d \
  --name fast-pdf \
  --restart unless-stopped \
  -p 2626:2626 \
  -e NODE_ENV=production \
  -e PORT=2626 \
  -e AUTH_PASSWORD="$(cat /etc/fast-pdf/auth_password)" \
  -e JWT_SECRET="$(cat /etc/fast-pdf/jwt_secret)" \
  -e SENTRY_DSN="$(cat /etc/fast-pdf/sentry_dsn)" \
  -e SENTRY_TRACES_SAMPLE_RATE=1.0 \
  -e OTEL_SERVICE_NAME="fast-pdf-prod" \
  yourorg/fast-pdf:latest
```

Store secrets in files under `/etc/fast-pdf/` (owner: `forge`, mode: `0600`) so they never appear in process listings.

**Option B — docker-compose on each server**

Create `/home/forge/fast-pdf/docker-compose.yml` on each server:

```yaml
services:
  fast-pdf:
    image: yourorg/fast-pdf:latest
    restart: unless-stopped
    ports:
      - '2626:2626'
    env_file: /home/forge/fast-pdf/.env
    healthcheck:
      test: ['CMD', 'node', '-e', "require('http').get('http://localhost:2626/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 20s
```

Create `/home/forge/fast-pdf/.env` on each server (set permissions `chmod 600`):

```dotenv
NODE_ENV=production
PORT=2626
HOST=0.0.0.0
AUTH_PASSWORD=<strong-secret>
JWT_SECRET=<strong-secret>
JWT_EXPIRES_IN=1d
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
SENTRY_DSN=https://<key>@o<org>.ingest.sentry.io/<project>
SENTRY_TRACES_SAMPLE_RATE=1.0
OTEL_SERVICE_NAME=fast-pdf-prod
```

Forge deploy script (runs on each deploy):

```bash
#!/bin/bash
set -euo pipefail

cd /home/forge/fast-pdf
docker pull yourorg/fast-pdf:latest
docker compose up -d --remove-orphans
docker image prune -f
```

### 9c. NGINX reverse proxy on each Forge server

Add a Forge-managed site for `pdf.yourdomain.com` with this NGINX config:

```nginx
server {
    listen 80;
    server_name pdf.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name pdf.yourdomain.com;

    # TLS — managed by Forge / Let's Encrypt
    ssl_certificate     /etc/nginx/ssl/pdf.yourdomain.com/server.crt;
    ssl_certificate_key /etc/nginx/ssl/pdf.yourdomain.com/server.key;

    client_max_body_size 10M;

    location / {
        proxy_pass         http://127.0.0.1:2626;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;  # PDF renders can take time
        proxy_send_timeout 120s;
    }

    location /health {
        proxy_pass http://127.0.0.1:2626/health;
        access_log off;
    }
}
```

### 9d. Zero-downtime deploys on each server

Because Docker with `restart: unless-stopped` is used, deployments work like this:

```bash
docker pull yourorg/fast-pdf:latest
docker compose up -d  # replaces running container, new one starts before old stops
```

For true zero-downtime with NGINX, you can run two containers (`:2626` and `:3001`) behind a local upstream block, then rotate them one at a time. This is optional for the two-server setup since the other server stays live during a deploy.

---

## Step 10 — Sentry Monitoring & Observability

### 10a. Sentry OTLP Integration

FastPDF sends traces and metrics directly to Sentry via its OTLP endpoint. No separate collector is required.

**How it works:**
1. The `SENTRY_DSN` environment variable is parsed to extract your Sentry organization and project IDs
2. The telemetry module constructs the OTLP endpoint: `https://o<org>.ingest.sentry.io/api/<project>/integration/otlp`
3. Traces and metrics are sent with the `x-sentry-auth` header containing your public key
4. Sentry ingests the data and displays it in the Performance and Metrics views

**Configuration:**
```dotenv
SENTRY_DSN=https://<key>@o<org>.ingest.sentry.io/<project>
SENTRY_TRACES_SAMPLE_RATE=1.0
```

**What to monitor in Sentry:**

| Signal | Where to find it | What to watch |
|--------|-----------------|---------------|
| `pdf.render` span duration | Performance → Traces | p50, p95, p99 render times |
| `http.server.duration` | Performance → Traces | Overall request latency per route |
| Error rate on `pdf-render` route | Issues → Performance | Alerts if > 1% |
| Heap memory via `process.memoryUsage()` | Metrics (if enabled) | Chromium memory leaks |
| Container restart count | Uptime monitoring | Stability indicator |
| `/health` HTTP 200 rate | Uptime monitoring | Uptime |

### 10b. Sentry Dashboards

- **Performance**: View trace waterfalls for each PDF render, identify slow renders
- **Issues**: Automatic error capture with stack traces and context
- **Metrics**: Custom metrics for render duration, success rate, and throughput
- **Alerts**: Set up alerts for error rate spikes or latency degradation

### 10c. Sentry-only telemetry

This repository now uses Sentry as the only supported telemetry backend. If you do not configure `SENTRY_DSN`, telemetry stays disabled and the service runs without outbound tracing or metrics export.

### 10d. Shared k6 helpers

The k6 load tests now share fixture and header helpers in [load-test/shared.js](../load-test/shared.js).

That file is imported by [load-test/baseline.js](../load-test/baseline.js), [load-test/stress.js](../load-test/stress.js), and [load-test/auth-and-render.js](../load-test/auth-and-render.js).

---

## Step 11 — Security Hardening Checklist

- [ ] `AUTH_PASSWORD` and `JWT_SECRET` are at least 32 characters, randomly generated
- [ ] `SENTRY_DSN` is stored securely (it contains a public key, but treat it as sensitive)
- [ ] Secrets are stored in Forge's encrypted env manager or `/etc/fast-pdf/` files with `0600` permissions, not in `.env` committed to git
- [ ] Add `.env` to `.gitignore`
- [ ] Docker container runs as non-root (`fast-pdf` user — handled in hardened Dockerfile above)
- [ ] NGINX enforces TLS (Let's Encrypt via Forge)
- [ ] `client_max_body_size` limits request size at the NGINX layer
- [ ] Error responses do not expose stack traces or internal error messages to the client
- [ ] JWT tokens expire in ≤24 hours and are re-issued by the Laravel service (already cached in `FastPdfService`)
- [ ] Add `@fastify/rate-limit` to protect `/authenticate` from brute force

Rate limit example:

```typescript
// in src/app.ts
import rateLimit from '@fastify/rate-limit';
await app.register(rateLimit, {
  max: 10,
  timeWindow: '1 minute',
  keyGenerator: (req) => req.ip,
});
```

---

## Step 12 — CI/CD Pipeline (GitHub Actions example)

```yaml
# .github/workflows/deploy.yml
name: Build & Deploy

on:
  push:
    branches: [main]

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - name: Log in to Docker Hub
        uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_TOKEN }}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          push: true
          tags: |
            yourorg/fast-pdf:latest
            yourorg/fast-pdf:${{ github.sha }}

  deploy-server-a:
    needs: build-and-push
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to Server A
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SERVER_A_HOST }}
          username: forge
          key: ${{ secrets.SERVER_A_SSH_KEY }}
          script: |
            cd /home/forge/fast-pdf
            docker pull yourorg/fast-pdf:latest
            docker compose up -d --remove-orphans
            docker image prune -f

  deploy-server-b:
    needs: build-and-push
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to Server B
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SERVER_B_HOST }}
          username: forge
          key: ${{ secrets.SERVER_B_SSH_KEY }}
          script: |
            cd /home/forge/fast-pdf
            docker pull yourorg/fast-pdf:latest
            docker compose up -d --remove-orphans
            docker image prune -f
```

---

## Ordered Completion Checklist

Use this as the canonical sprint list:

### Code fixes (do first)
- [ ] Remove `"type": "module"` from `package.json` and verify build
- [ ] Fix `fastify.d.ts` — add `pdfRenderService` declaration
- [ ] Strip internal error details from client responses in `pdf-render.controller.ts`
- [ ] Add `PUPPETEER_EXECUTABLE_PATH` env override in `pdf-render.service.ts`

### New code
- [ ] Create `src/env.ts` — startup env validation (includes Sentry DSN)
- [ ] Create `src/telemetry.ts` — OTel SDK init with Sentry OTLP support
- [ ] Wire telemetry into `src/server.ts` (must be first import)
- [ ] Add manual span around `renderHTML()` in `pdf-render.service.ts`
- [ ] Enrich `/health` to return JSON with uptime and memory
- [ ] Add `@fastify/rate-limit` to `src/app.ts`
- [ ] Expand `test/test.ts` with auth and render integration tests
- [ ] Create `load-test/auth-and-render.js` (k6 baseline)
- [ ] Create `load-test/stress.js` (k6 stress)
- [ ] Add `load-test/runs/` to `.gitignore`

### Infrastructure
- [ ] Replace `Dockerfile` with multi-stage hardened version
- [ ] Create `.env.example` in repo root (includes Sentry DSN)
- [ ] Add Forge docker-compose template (`infra/forge/docker-compose.yml`)

### Deployment
- [ ] Create container registry repo and GitHub Actions secrets (`DOCKER_USERNAME`, `DOCKER_TOKEN`)
- [ ] Push Docker image to registry (Docker Hub or GHCR)
- [ ] Set up Forge daemon / docker-compose on Server A
- [ ] Set up Forge daemon / docker-compose on Server B
- [ ] Configure NGINX reverse proxy on each server
- [ ] Point `/health` monitor (Uptime Kuma or Better Stack) at both servers
- [ ] Configure Sentry project and obtain DSN
- [ ] Set `SENTRY_DSN` in Forge environment variables
- [ ] Wire GitHub Actions CI/CD pipeline
- [ ] Run baseline k6 load test against production
- [ ] Run stress k6 load test and record results
