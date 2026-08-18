# FastPDF Reference Guide

This guide collects practical learning notes for the main technologies used in this project.

## 1. Fastify

Fastify is the web framework used to expose the API.

### What it does here
- Creates the HTTP server and route registration.
- Handles authentication hooks and request lifecycle hooks.
- Serves the health endpoint and the protected PDF rendering endpoint.

### Key concepts
- `app.register()` plugs in modules and features.
- `app.route()` defines an endpoint and its handler.
- `preHandler` and hooks let you run authentication or logging logic before the route handler.
- `app.inject()` is useful for testing routes without opening a real network port.

### In this repo
- [src/app.ts](../src/app.ts) builds the Fastify instance.
- [src/modules/auth/auth.routes.ts](../src/modules/auth/auth.routes.ts) defines the auth route.
- [src/modules/pdf-render/pdf-render.routes.ts](../src/modules/pdf-render/pdf-render.routes.ts) defines the protected render route.

## 2. TypeScript

TypeScript adds static types to the Node.js service.

### Why it matters here
- Improves safety around request payloads and environment variables.
- Helps keep route handlers, controllers, and services consistent.

### Common patterns used
- Interfaces and types for request/response data.
- Strongly-typed environment configuration via Zod.
- Shared types for render options and request payloads.

## 3. Zod

Zod is used for validating incoming data and environment configuration.

### What it does here
- Validates the auth request body.
- Validates the PDF render request body.
- Validates required environment variables before the server starts.

### Example idea
- A request with a missing or empty HTML field is rejected before rendering begins.
- An invalid or too-short JWT secret causes startup validation to fail.

### In this repo
- [src/env.ts](../src/env.ts)
- [src/modules/auth/auth.schema.ts](../src/modules/auth/auth.schema.ts)
- [src/modules/pdf-render/pdf-render.schema.ts](../src/modules/pdf-render/pdf-render.schema.ts)

## 4. Puppeteer and Chromium

Puppeteer controls headless Chromium to render HTML into PDF.

### What it does here
- Launches a browser instance.
- Opens a page per render request.
- Loads HTML content and generates a PDF buffer.

### Key concepts
- `browser.newPage()` creates a fresh page.
- `page.setContent()` loads HTML.
- `page.pdf()` writes the PDF output.
- Browser startup flags are important in Docker and CI environments.

### In this repo
- [src/modules/pdf-render/pdf-render.service.ts](../src/modules/pdf-render/pdf-render.service.ts)

## 5. JWT and authentication

The service uses JWTs for protected PDF rendering.

### Flow
1. Client sends a password to /authenticate.
2. Server checks it against AUTH_PASSWORD.
3. Server returns a JWT.
4. Client sends the JWT in the Authorization header for /pdf-render.

### Key concepts
- `@fastify/jwt` signs and verifies JWTs.
- `@fastify/auth` helps compose authentication logic for routes.
- The server must keep JWT_SECRET safe and consistent across restarts.

### In this repo
- [src/app.ts](../src/app.ts)
- [src/modules/auth/auth.controller.ts](../src/modules/auth/auth.controller.ts)
- [src/modules/pdf-render/pdf-render.routes.ts](../src/modules/pdf-render/pdf-render.routes.ts)

## 6. Sentry and local logs

The service sends errors and unhandled exceptions to Sentry when `SENTRY_DSN` is configured. Structured request and rendering logs remain in the local container logs.

### In this repo
- [src/sentry.ts](../src/sentry.ts)
- [src/modules/pdf-render/pdf-render.controller.ts](../src/modules/pdf-render/pdf-render.controller.ts)
- [test/sentry-smoke.ts](../test/sentry-smoke.ts)

To verify delivery manually, run `npm run test:sentry` from the FastPDF directory. The command requires `SENTRY_DSN`, sends one deliberately generated exception, waits for the SDK flush, and prints the event ID.

## 7. Node.js test runner

The project uses Node's built-in test runner with `tsx`.

### Why it is useful
- Fast and simple for integration tests.
- Works well with Fastify's `app.inject()` helper.
- Good fit for route-level tests without extra test frameworks.

### In this repo
- [test/test.ts](../test/test.ts)

## 8. Request lifecycle and app structure

A typical request follows this path:

1. Fastify receives the HTTP request.
2. Authentication or validation runs if required.
3. The controller passes the request to the service layer.
4. The PDF service renders HTML with Puppeteer.
5. The response is returned as a PDF binary.

## 9. Load-test helpers

The k6 scripts share fixture loading and header helpers in [load-test/shared.js](../load-test/shared.js).

### In this repo
- [load-test/baseline.js](../load-test/baseline.js)
- [load-test/stress.js](../load-test/stress.js)
- [load-test/auth-and-render.js](../load-test/auth-and-render.js)

## Common commands

```bash
npm install
cp .env.example .env
npm run dev
npm run test
npm run build
```

## Troubleshooting

- If Chromium fails to start, check the Puppeteer executable path and the container image dependencies.
- If auth fails, confirm AUTH_PASSWORD and JWT_SECRET are set and meet the minimum length rules.
- If the render route rejects the request, check the body size and ensure the HTML field is present.
- If Sentry issues are absent, confirm SENTRY_DSN is set and valid, then run `npm run test:sentry` and search using the printed event ID.
