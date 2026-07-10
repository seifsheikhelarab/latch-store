import { describe, it, expect, beforeEach } from 'bun:test'
import { processIdempotentKey, parseTTL, sleep } from './core.js'
import { memoryStore } from './memory-store.js'
import { idempotentExpress } from './express.js'
import { idempotentHono } from './hono.js'
import type { Store, Entry, IdempotencyEvent } from './types.js'

// ── TTL Parser ──

describe('parseTTL', () => {
  it('parses hours', () => { expect(parseTTL('1h')).toBe(3_600_000) })
  it('parses minutes', () => { expect(parseTTL('30m')).toBe(1_800_000) })
  it('parses days', () => { expect(parseTTL('7d')).toBe(604_800_000) })
  it('defaults to 24h', () => { expect(parseTTL('24h')).toBe(86_400_000) })
  it('rejects invalid format', () => { expect(() => parseTTL('abc')).toThrow() })
  it('rejects unknown unit', () => { expect(() => parseTTL('5x')).toThrow() })
})

// ── Memory Store ──

describe('memoryStore', () => {
  let store: Store

  beforeEach(() => { store = memoryStore() })

  it('setIfAbsent returns true for new key', async () => {
    const result = await store.setIfAbsent('k1', { status: 'pending', bodyHash: 'abc' }, 60_000)
    expect(result).toBe(true)
  })

  it('setIfAbsent returns false for existing key', async () => {
    await store.setIfAbsent('k1', { status: 'pending', bodyHash: 'abc' }, 60_000)
    const result = await store.setIfAbsent('k1', { status: 'pending', bodyHash: 'def' }, 60_000)
    expect(result).toBe(false)
  })

  it('get returns stored entry', async () => {
    const entry: Entry = { status: 'complete', bodyHash: 'abc', statusCode: 200, headers: {}, body: 'ok' }
    await store.set('k1', entry, 60_000)
    const result = await store.get('k1')
    expect(result).toEqual(entry)
  })

  it('get returns null for missing key', async () => {
    const result = await store.get('nonexistent')
    expect(result).toBeNull()
  })

  it('del removes entry', async () => {
    await store.set('k1', { status: 'pending', bodyHash: 'abc' }, 60_000)
    await store.del('k1')
    const result = await store.get('k1')
    expect(result).toBeNull()
  })

  it('del is no-op for missing key', async () => {
    await store.del('nonexistent')
    // Should not throw
  })

  it('expires entries after TTL', async () => {
    await store.setIfAbsent('k1', { status: 'pending', bodyHash: 'abc' }, 10)
    expect(await store.get('k1')).not.toBeNull()
    await sleep(20)
    expect(await store.get('k1')).toBeNull()
  })
})

// ── Core Idempotency Logic ──

describe('processIdempotentKey', () => {
  let store: Store
  let events: IdempotencyEvent[]

  beforeEach(() => {
    store = memoryStore()
    events = []
  })

  const handler = (statusCode = 200, body = 'done') =>
    async () => ({ statusCode, headers: { 'content-type': 'application/json' } as Record<string, string>, body })

  const onEvent = (e: IdempotencyEvent) => { events.push(e) }

  it('completes first request and stores response', async () => {
    let called = 0
    const h = async () => { called++; return { statusCode: 200, headers: {}, body: 'ok' } }
    const result = await processIdempotentKey('k1', new Uint8Array(), h, store, 60_000, onEvent)
    expect(result.status).toBe('completed')
    expect(result.body).toBe('ok')
    expect(called).toBe(1)
    expect(events).toEqual([{ type: 'key.created', key: 'k1' }])
  })

  it('replays cached response on duplicate after completion', async () => {
    let called = 0
    const h = async () => { called++; return { statusCode: 200, headers: {}, body: 'ok' } }
    await processIdempotentKey('k1', new Uint8Array(), h, store, 60_000, onEvent)
    const result = await processIdempotentKey('k1', new Uint8Array(), h, store, 60_000, onEvent)
    expect(result.status).toBe('replayed')
    expect(result.body).toBe('ok')
    expect(called).toBe(1)
    expect(events).toHaveLength(2)
    expect(events[1]).toEqual({ type: 'key.replayed', key: 'k1' })
  })

  it('detects body hash mismatch and returns 409', async () => {
    await processIdempotentKey('k1', new TextEncoder().encode('body1'), handler(), store, 60_000, onEvent)
    const result = await processIdempotentKey('k1', new TextEncoder().encode('body2'), handler(), store, 60_000, onEvent)
    expect(result.status).toBe('conflict')
    expect(result.statusCode).toBe(409)
    expect(events).toHaveLength(2)
    expect(events[1]).toEqual({ type: 'key.conflict', key: 'k1' })
  })

  it('cleans up key on handler error, allowing retry', async () => {
    let called = 0
    const failingHandler = async () => { called++; throw new Error('handler failed') }
    const succeedingHandler = async () => { called++; return { statusCode: 200, headers: {}, body: 'retry ok' } }

    await expect(processIdempotentKey('k1', new Uint8Array(), failingHandler, store, 60_000, onEvent)).rejects.toThrow('handler failed')
    const result = await processIdempotentKey('k1', new Uint8Array(), succeedingHandler, store, 60_000, onEvent)
    expect(result.status).toBe('completed')
    expect(result.body).toBe('retry ok')
    expect(called).toBe(2)
  })

  it('degrades gracefully on store error', async () => {
    const badStore: Store = {
      setIfAbsent: async () => { throw new Error('store down') },
      set: async () => { throw new Error('store down') },
      get: async () => { throw new Error('store down') },
      del: async () => { throw new Error('store down') },
    }
    const result = await processIdempotentKey('k1', new Uint8Array(), handler(200, 'passthrough'), badStore, 60_000, onEvent)
    expect(result.status).toBe('passthrough')
    expect(result.body).toBe('passthrough')
  })

  it('expires keys after TTL', async () => {
    await processIdempotentKey('k1', new Uint8Array(), handler(), store, 10)
    await sleep(20)
    const result = await processIdempotentKey('k1', new Uint8Array(), handler(), store, 60_000)
    expect(result.status).toBe('completed')
  })
})

// ── Express Middleware ──

describe('idempotentExpress', () => {
  it('passes through when no idempotency key', async () => {
    const store = memoryStore()
    const middleware = idempotentExpress({ store })
    let nextCalled = false
    const req = { headers: {}, body: undefined, on: (_event: string, cb: any) => { if (_event === 'end') cb() } }
    const res = { status: () => res, json: () => res, send: () => res, setHeader: () => {}, headersSent: false }
    await middleware(req as any, res as any, () => { nextCalled = true })
    expect(nextCalled).toBe(true)
  })

  it('completes a request with idempotency key', async () => {
    const store = memoryStore()
    const middleware = idempotentExpress({ store })
    let statusCode = 0; let sentBody = ''
    const req = { headers: { 'idempotency-key': 'k1' }, body: {}, on: (_event: string, cb: any) => { if (_event === 'end') cb() } }
    const res = {
      status: (code: number) => { statusCode = code; return res },
      json: () => res,
      send: (body: string) => { sentBody = body; return res },
      setHeader: () => {},
      headersSent: false,
    }
    // next simulates the Express route handler that runs after the middleware
    await middleware(req as any, res as any, () => { res.send('test response') })
    expect(statusCode).toBe(200)
    expect(sentBody).toBe('test response')
  })
})

// ── Hono Middleware (unit) ──

describe('idempotentHono', () => {
  it('passes through when no idempotency key', async () => {
    const store = memoryStore()
    const middleware = idempotentHono({ store })
    let nextCalled = false
    const c = {
      req: { header: () => undefined, text: async () => '' },
      res: new Response(),
      newResponse: () => new Response(),
    }
    await middleware(c as any, async () => { nextCalled = true })
    expect(nextCalled).toBe(true)
  })

  it('replays captured response body', async () => {
    const store = memoryStore()
    const middleware = idempotentHono({ store })
    const c = {
      req: { header: (name: string) => name === 'Idempotency-Key' ? 'k1' : undefined, text: async () => '' },
      res: new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }),
      newResponse: (body: string | null, status: number, headers: Record<string, string>) => new Response(body, { status, headers }),
    }
    // First call: next() runs the handler which sets c.res to our mock
    // After next(), captureHonoResponse clones c.res and reads body
    const result = await middleware(c as any, async () => {})
    expect(result).toBeInstanceOf(Response)
    if (result) {
      const text = await result.text()
      expect(text).toBe('hello')
      expect(result.status).toBe(200)
    }
  })
})

// ── Load Test ──

describe('load test', () => {
  it('100 concurrent requests with same key produce exactly one handler execution', async () => {
    const store = memoryStore()
    let handlerCalls = 0
    const handler = async () => { handlerCalls++; return { statusCode: 200, headers: {} as Record<string, string>, body: 'ok' } }

    const promises: Promise<void>[] = []
    for (let i = 0; i < 100; i++) {
      promises.push(
        processIdempotentKey('load-key', new Uint8Array(), handler, store, 60_000)
          .then(() => {}) as Promise<void>
      )
    }

    await Promise.all(promises)
    expect(handlerCalls).toBe(1)
  })
})


