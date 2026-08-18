# FastPDF Architecture Diagram

```mermaid
flowchart LR
  Client[Client / API Consumer] -->|POST /authenticate| Auth[Auth Module]
  Client -->|POST /pdf-render| Render[PDF Render Module]

  subgraph App[Fastify Application]
    Router[Routes + Validation]
    AuthCtrl[Auth Controller]
    RenderCtrl[PDF Render Controller]
    RenderSvc[PDF Render Service]
    Env[Environment Validation]

    Router --> AuthCtrl
    Router --> RenderCtrl
    RenderCtrl --> RenderSvc
    RenderSvc --> Browser[Chromium via Puppeteer]
    Env --> Router
  end

  AuthCtrl --> JWT[JWT Issuance / Verification]
  RenderSvc --> PDF[(PDF Buffer)]
  PDF --> Client
  JWT --> Client
```

## Current architecture notes

- The service is synchronous: each request receives a PDF response directly from the HTTP request.
- Authentication uses a shared password at /authenticate and JWTs for protected PDF rendering.
- PDF generation runs in-process with Puppeteer and Chromium.
- Sentry reporting is optional and captures errors and unhandled exceptions when SENTRY_DSN is configured.
- Request and rendering logs remain in the local container logs.
- `npm run test:sentry` deliberately sends one smoke-test exception for delivery verification.
