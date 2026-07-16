# latch-store

**latch-store** is a Node/Bun middleware library that makes any mutating endpoint idempotent with one line of code. It provides:

- **Two framework-specific entry points**: `idempotent.express()` and `idempotent.hono()`.
- **A pluggable store interface** with two built-in adapters: `memoryStore()` (dev/test) and `redisStore()` (production).
- **Correctness guarantees** under concurrent duplicate requests via atomic store operations and polling.
- **Body-hash mismatch detection** to reject key reuse with different payloads.
- **A callback-based event system** for observability.
- **Graceful degradation** when the store is unavailable.

## Quick Start

```bash
npm install latch-store
# or
bun add latch-store
```

### Express

```ts
import { idempotent, memoryStore } from 'latch-store'

const store = memoryStore()
const app = express()

app.post('/charge', idempotent.express({ store }), async (req, res) => {
  // This handler runs at most once per unique Idempotency-Key
  res.json({ status: 'charged' })
})
```

### Hono

```ts
import { idempotent, memoryStore } from 'latch-store'

const store = memoryStore()
const app = new Hono()

app.post('/charge', idempotent.hono({ store }), async (c) => {
  return c.json({ status: 'charged' })
})
```

## API

See the [generated documentation](https://seifsheikhelarab.github.io/latch-store) for the full API reference.

### Store Adapters

| Adapter | Factory | Use Case |
|---------|---------|----------|
| In-memory | `memoryStore()` | Local dev, tests |
| Redis | `redisStore()` | Production, multi-instance |

### Custom Adapter

Implement the `Store` interface (4 methods):

```ts
import type { Store } from 'latch-store'

class MyStore implements Store {
  async setIfAbsent(key, value, ttlMs) { /* ... */ }
  async set(key, value, ttlMs) { /* ... */ }
  async get(key) { /* ... */ }
  async del(key) { /* ... */ }
}
```

## Development

```bash
bun install
bun test          # run tests
bun run typecheck # type-check all source files
```

## License

MIT
