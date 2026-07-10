# PRD: Idempotency Middleware Module

## Problem

Backend services that expose mutating endpoints (payments, job creation, webhook handlers) need to guarantee that a duplicate request executes side effects once. Today every team solves this by hand: a Redis key check, a database unique constraint, or nothing at all. The common failure modes are the same everywhere:

- Two identical requests arrive within milliseconds and both pass a check-then-set race, causing double execution.
- A client retries after a timeout, but the original request had already succeeded, so the retry re-runs the handler and returns a different response than the first call.
- Keys never expire, so storage grows unbounded, or they expire too early and lose protection.

There is no small, dependency-light library that solves just this problem well. Existing options are either full workflow engines (Temporal, Inngest) that require adopting an entire execution model, or hosted services (Svix) scoped to webhooks specifically.

## Goal

Ship a Node/Bun middleware library that makes any mutating endpoint idempotent with one line of code, with correctness guarantees under concurrent duplicate requests.

## Non-goals

- Not a job queue or workflow engine. It wraps a single request/response cycle, not multi-step processes.
- Not a distributed lock library for general use. Locking is an internal implementation detail, not a public API.
- No hosted service in v1. Ships as an npm package only.

## Users

Backend engineers building APIs that accept an `Idempotency-Key` header: payment endpoints, order creation, webhook receivers, any POST/PUT that triggers a side effect.

## Core guarantees

1. Two requests with the same idempotency key, sent concurrently, produce exactly one execution of the handler. The second request waits for the first to finish and receives its response.
2. A request retried after the original completed returns the stored response without re-running the handler, for the configured retention window.
3. A request that arrives with the same key but a different body is rejected with a conflict error, since it likely indicates a client bug or key collision.
4. Keys expire after a configurable TTL (default 24 hours) and are cleaned up automatically.

## API design

```ts
import { idempotent } from 'idempotency-middleware';

app.post('/charge', idempotent({ store: redisStore, ttl: '24h' }), handler);
```

Behavior:
- Reads `Idempotency-Key` from the request header. If absent, the middleware is a no-op and the request proceeds normally.
- Hashes the key together with the request body to detect body mismatches on key reuse.
- On first sighting of a key: acquires a short-lived lock, runs the handler, stores the response, releases the lock.
- On a concurrent duplicate: blocks until the lock is released, then returns the stored response.
- On a post-completion duplicate: returns the stored response immediately, no handler execution.

Storage is pluggable through an adapter interface. v1 ships a Redis adapter, since that's the common case for this kind of state. A Postgres adapter is a reasonable v2 addition for teams that don't run Redis.

## Out of scope for v1

- No built-in observability dashboard. Emits events (`key.created`, `key.replayed`, `key.conflict`) that the host app can log or forward to its own metrics.
- No automatic retry of the handler itself. This library prevents duplicate execution, it doesn't add retry logic on top.

## Success criteria

- A duplicate request storm (100 concurrent requests, same key) results in exactly one handler execution, verified by a load test in the project's own test suite.
- Integration into the job scheduler's worker task execution path replaces the current ad hoc idempotency handling with no behavior regression.
- Package installs and works with zero configuration beyond passing a store adapter.

## Milestones

1. Core middleware with in-memory store, for local dev and tests.
2. Redis adapter, lock acquisition via `SET NX PX`, response caching.
3. Body-hash mismatch detection and conflict response.
4. Load test suite proving the concurrency guarantee.
5. Dogfood in the job scheduler's worker module, replace existing idempotent-retry logic.
6. Publish to npm with a README that leads with the problem and a two-block before/after code example.
