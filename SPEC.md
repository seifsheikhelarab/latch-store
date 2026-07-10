# Spec: Idempotency Middleware — `latch-store`

## Problem Statement

Backend services that expose mutating endpoints (payments, job creation, webhook handlers) need to guarantee that a duplicate request executes side effects exactly once. Today every team solves this by hand: a Redis key check, a database unique constraint, or nothing at all. The common failure modes are identical everywhere:

- Two identical requests arrive within milliseconds and both pass a check-then-set race, causing double execution.
- A client retries after a timeout, but the original request had already succeeded, so the retry re-runs the handler and returns a different response than the first call.
- Keys never expire, so storage grows unbounded, or they expire too early and lose protection.

There is no small, dependency-light library that solves just this problem well. Existing options are either full workflow engines (Temporal, Inngest) that require adopting an entire execution model, or hosted services (Svix) scoped to webhooks specifically.

## Solution

Ship a Node/Bun middleware library (`latch-store`) that makes any mutating endpoint idempotent with one line of code. The library provides:

- Two framework-specific entry points: `idempotentExpress()` and `idempotentHono()`.
- A pluggable store interface with two built-in adapters: `memoryStore()` (dev/test) and `redisStore()` (production).
- Correctness guarantees under concurrent duplicate requests via atomic store operations and polling.
- Body-hash mismatch detection to reject key reuse with different payloads.
- A callback-based event system for observability.
- Graceful degradation when the store is unavailable.

## User Stories

1. As a backend engineer, I want to add idempotency to an Express endpoint with a single middleware call, so that I don't have to implement locking logic by hand.
2. As a backend engineer, I want to add idempotency to a Hono endpoint with a single middleware call, so that I get the same guarantees across frameworks.
3. As a backend engineer, I want two concurrent requests with the same idempotency key to produce exactly one handler execution, so that payments are never double-charged.
4. As a backend engineer, I want a concurrent duplicate to block until the first request finishes and then receive the stored response, so that the client always gets a valid result.
5. As a backend engineer, I want a request retried after the original completed to return the cached response without re-running the handler, so that retries are safe.
6. As a backend engineer, I want a request with the same key but a different body to be rejected with a 409 Conflict, so that key collisions or client bugs are caught immediately.
7. As a backend engineer, I want keys to expire after a configurable TTL (default 24h) with automatic cleanup, so that storage doesn't grow unbounded.
8. As a backend engineer, I want to choose a custom TTL using human-readable strings like `'24h'`, `'30m'`, or `'7d'`, so that configuration is readable at a glance.
9. As a backend engineer, I want the TTL to be fixed from first creation and not reset on replay, so that key lifetime is predictable and bounded.
10. As a backend engineer, I want the middleware to be a no-op when no `Idempotency-Key` header is present, so that I can apply it broadly without breaking non-idempotent endpoints.
11. As a backend engineer, I want to use an in-memory store for local development and tests, so that I don't need Redis running locally.
12. As a backend engineer, I want a Redis adapter for production use, so that idempotency works across multiple server instances.
13. As a backend engineer, I want the store interface to be minimal (four methods), so that writing custom adapters is trivial.
14. As a backend engineer, I want the middleware to degrade gracefully when the store is unreachable, so that API availability isn't coupled to Redis uptime.
15. As a backend engineer, I want to receive events (`key.created`, `key.replayed`, `key.conflict`) via a callback, so that I can log or emit metrics without polling.
16. As a backend engineer, I want handler errors to clean up the pending key, so that clients can retry with the same key after a transient failure.
17. As a backend engineer, I want the response (status code, headers, body) to be fully cached and replayed, so that the client receives an identical response on retry.
18. As a backend engineer, I want the middleware to buffer and hash the request body on every request, so that body mismatches on key reuse are always detected.
19. As a backend engineer, I want to import everything from the root path (`import { idempotentExpress, memoryStore } from 'latch-store'`), so that imports are simple and consistent.
20. As a backend engineer, I want the library to be ESM-only with TypeScript, so that it works natively in Bun and with standard tooling in Node.
21. As a backend engineer, I want the library to install with zero configuration beyond passing a store adapter, so that onboarding is instant.
22. As a backend engineer, I want a load test in the test suite that proves 100 concurrent requests with the same key result in exactly one handler execution, so that the concurrency guarantee is verified automatically.
23. As a backend engineer, I want every public symbol to have JSDoc, so that I can understand the API from my editor without leaving the codebase.
24. As a backend engineer, I want generated API docs published to GitHub Pages, so that my team can browse the documentation without cloning the repo.
25. As a backend engineer, I want a README with a quick-start guide and API summary, so that I can integrate the library in under a minute.
26. As a backend engineer, I want CI to run tests and typechecks on every push and PR, so that regressions are caught before merge.
27. As a backend engineer, I want `bun test` and `bun run typecheck` scripts in package.json, so that I can verify correctness locally with two commands.

## Implementation Decisions

### Module Structure

Seven source files organized around a deep core module:

- **Core module** — contains all idempotency logic: lock acquisition via atomic store operations, poll-wait for concurrent duplicates, body hashing (SHA-256, inline), TTL string parsing (inline), response capture orchestration, event emission, store error degradation, and handler error cleanup via try/finally.
- **Types module** — defines the store interface, entry shape, options, and event types. This is the seam at which adapters are written.
- **Framework adapters** — two thin adapters (Express, Hono) that read the idempotency key from headers, buffer the request body, delegate to the core module, and write the cached response back. Approximately 20 lines each.
- **Store adapters** — two thin adapters (memory, Redis) implementing the store interface. Memory uses a Map with setTimeout for TTL. Redis uses `SET NX PX` for atomic claim-and-lock.

### Store Interface

The store interface has four methods:

- `setIfAbsent(key, value, ttlMs) → boolean` — Atomic: set key only if absent. Returns true if this call created the key. Used for lock acquisition.
- `set(key, value, ttlMs) → void` — Unconditional overwrite. Used to store the response after handler completion.
- `get(key) → Entry | null` — Read stored entry. Returns null if expired or missing. Used for poll-wait and post-completion replay.
- `del(key) → void` — Delete entry. Used for cleanup on handler error.

The entry shape stored by the core module:

- `status: 'pending' | 'complete'` — Whether the handler has finished.
- `bodyHash: string` — SHA-256 hex digest of the concatenation of the idempotency key and the raw request body bytes.
- `statusCode?: number` — HTTP status code of the cached response (set when status is `complete`).
- `headers?: Record<string, string>` — Response headers to replay (set when status is `complete`).
- `body?: string` — Serialized response body to replay (set when status is `complete`).

### Concurrency Model

Poll-wait. When a concurrent duplicate arrives (setIfAbsent returns false), the middleware polls `get(key)` with a 50ms interval until the entry's status changes from `pending` to `complete`. This works across multiple server instances with no in-process state.

### Lock Acquisition and Cleanup

The core module wraps handler execution in a try/finally. On success, it overwrites the pending entry with the complete response. On any error (handler throw, unexpected failure), it deletes the key entirely, allowing clients to retry with the same key.

### Response Capture

- Express: monkey-patch `res.status()`, `res.json()`, and `res.send()` to intercept the response before it is flushed. The handler runs normally; the middleware captures what it sends.
- Hono: wrap the handler's return value. Hono handlers return a `Response` directly, so the middleware awaits it, reads it, clones it, and stores the result.

### Body Hashing

SHA-256 via the Web Crypto API (`crypto.subtle.digest`). The hash input is the concatenation of the idempotency key bytes and the raw request body bytes. The hash is computed on every request (buffering the body), stored on first sighting, and compared on duplicate detection. Mismatch triggers a 409 Conflict response.

### TTL Parsing

A string parser that accepts `'Nh'` (hours), `'Nm'` (minutes), and `'Nd'` (days). Default TTL is `'24h'`. The parser converts to milliseconds for the store.

### Event System

A single callback function `onEvent` on the options object. The callback receives `{ type: 'key.created' | 'key.replayed' | 'key.conflict', key: string }`. Events are fire-and-forget. No EventEmitter, no AsyncIterator.

### Store Error Handling

When the store throws (connection refused, timeout, etc.), the middleware catches the error, emits a warning, and lets the request pass through to the handler with no idempotency protection. Availability is prioritized over duplicate protection.

### Missing Key Behavior

When no `Idempotency-Key` header is present, the middleware is a no-op — it calls next/the handler directly with no store interaction. This allows the middleware to be applied broadly without breaking non-idempotent endpoints.

### Dependencies

- `ioredis` is a hard runtime dependency (not a peer dependency). Everyone who installs `latch-store` gets it, regardless of whether they use the Redis adapter.
- No HTTP framework dependencies — Express and Hono are not in `package.json`. The adapters use duck-typing on the request/response objects.

### Package Configuration

- ESM-only (`"type": "module"` in package.json).
- TypeScript with strict mode, targeting ESNext with NodeNext module resolution.
- Exports via `"main"` pointing to `src/index.ts` for Bun native execution.
- Tests via Bun's built-in test runner (`bun test`).
- Scripts in `package.json`:
  - `"test": "bun test"` — runs all tests.
  - `"typecheck": "tsc --noEmit"` — runs the TypeScript compiler for type checking only.

### Documentation

Every exported function and interface in the public surface MUST have a JSDoc block describing:
- What the function/method does (behaviour, not implementation).
- Each parameter and its expected shape.
- The return value and its shape.
- Error modes — which errors a caller must handle.
- Invariants or ordering constraints the caller must respect.

JSDoc is required on:
- `processIdempotentKey` (core module entry point).
- `idempotentExpress` and `idempotentHono` (framework adapter entry points).
- `memoryStore` and `redisStore` (store adapter factory functions).
- The `Store` interface (all four methods).
- The `Entry` type and the `IdempotencyEvent` type.
- The TTL parser function.

Static documentation is generated from JSDoc using TypeDoc and published to GitHub Pages. The doc site is rebuilt on every push to `main`.

### README

A `README.md` at the project root, covering:
- Problem statement (1–2 paragraphs).
- Quick start: install, configure store, add middleware to an Express/Hono endpoint.
- API reference summary (linking to the generated docs for full detail).
- Store adapter guide: built-in adapters, writing a custom adapter.
- Development: how to run tests, typecheck, and build docs locally.

### CI/CD

GitHub Actions workflow (`.github/workflows/ci.yml`):
- Trigger: push to `main`, pull requests targeting `main`.
- Steps:
  1. Checkout.
  2. Install Bun.
  3. `bun install`.
  4. `bun test` — runs all tests (including the load test).
  5. `bun run typecheck` — TypeScript compiler check.
- On push to `main`, additionally:
  - Build and deploy TypeDoc to GitHub Pages.

## Testing Decisions

### Test Philosophy

Test external behavior, not implementation details. Each test should exercise the public interface (the middleware function and the store adapters) and verify observable outcomes: response status codes, response bodies, handler execution count, event emissions, and store state.

### Modules to Test

1. **Core idempotency logic** — tested via the `idempotentExpress` and `idempotentHono` functions against the in-memory store. Covers:
   - First request creates entry, runs handler, stores response.
   - Concurrent duplicate blocks, returns stored response, handler runs once.
   - Post-completion duplicate returns cached response, handler does not run.
   - Body mismatch on key reuse returns 409.
   - Missing idempotency key passes through (no-op).
   - Handler error cleans up key, allows retry.
   - Store error degrades gracefully (passthrough).
   - TTL expiration clears key.
   - Event callback receives correct events.

2. **TTL parser** — unit tests for string-to-millisecond conversion.

3. **Memory store adapter** — unit tests for all four store methods, TTL expiration.

4. **Redis store adapter** — integration tests against a real Redis instance (or a mock). Covers atomic claim, poll-wait, TTL.

5. **Load test** — 100 concurrent requests with the same key, asserting exactly one handler execution. This is the concurrency guarantee verification.

### Test Framework

Bun's built-in test runner. No additional test dependencies.

### Prior Art

No existing tests in the codebase (greenfield). The load test pattern (concurrent requests, assert handler count) is the key non-trivial test.

## Out of Scope

- Postgres or other store adapters (v2).
- Observability dashboard (events callback is sufficient for v1).
- Automatic retry of the handler (this library prevents duplicates, it does not add retry logic).
- Streaming response support (SSE, file downloads).
- Distributed lock libraries beyond Redis.
- Job queue or workflow engine functionality.
- Hosted service in v1.
- CJS build output.
- Custom hash algorithms.
- Refresh-on-access TTL behavior.
- Opt-out body hashing.

## Further Notes

The library name is `latch-store`. The original PRD referenced `idempotency-middleware` as the package name, but `latch-store` was chosen for branding reasons.

The dogfooding milestone (integrating into the job scheduler's worker module) depends on that external project and is not part of this library's implementation. It should be validated after the library is published.

The `exports` field in `package.json` is not used since everything is imported from the root path. The `"main"` field points to the TypeScript source directly, relying on Bun's native TypeScript execution. A build step for Node.js consumers may be needed before npm publication.
