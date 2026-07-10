import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Redis } from 'ioredis'
import { redisStore } from './redis-store.ts'
import { processIdempotentKey } from './core.ts'
import type { Entry } from './types.ts'

if (!process.env.REDIS_URL) {
  process.stderr.write('[redis-store.test.ts] Skipped — set REDIS_URL to enable\n')
} else {

const REDIS_URL = process.env.REDIS_URL

describe('redisStore', () => {
  let redis: Redis
  let store: ReturnType<typeof redisStore>

  beforeAll(async () => {
    redis = new Redis(REDIS_URL)
    store = redisStore(redis)
  })

  afterAll(async () => {
    await redis.quit()
  })

  beforeEach(async () => {
    await redis.flushdb()
  })

  it('setIfAbsent returns true for new key', async () => {
    const result = await store.setIfAbsent('k1', { status: 'pending', bodyHash: 'abc' }, 60_000)
    expect(result).toBe(true)
  })

  it('setIfAbsent returns false for existing key', async () => {
    await store.setIfAbsent('k1', { status: 'pending', bodyHash: 'abc' }, 60_000)
    const result = await store.setIfAbsent('k1', { status: 'pending', bodyHash: 'def' }, 60_000)
    expect(result).toBe(false)
  })

  it('setIfAbsent uses NX — concurrent attempts do not both succeed', async () => {
    const results = await Promise.all([
      store.setIfAbsent('lock', { status: 'pending', bodyHash: 'a' }, 60_000),
      store.setIfAbsent('lock', { status: 'pending', bodyHash: 'b' }, 60_000),
    ])
    const truths = results.filter(Boolean).length
    expect(truths).toBe(1)
  })

  it('stores and retrieves entry', async () => {
    const entry: Entry = { status: 'complete', bodyHash: 'abc', statusCode: 200, headers: { 'x-foo': 'bar' }, body: 'ok' }
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
  })

  it('expires entries after TTL', async () => {
    await store.setIfAbsent('k1', { status: 'pending', bodyHash: 'abc' }, 50)
    await store.set('k1', { status: 'complete', bodyHash: 'abc', statusCode: 200, headers: {}, body: 'x' }, 50)
    expect(await store.get('k1')).not.toBeNull()
    await new Promise(r => setTimeout(r, 100))
    expect(await store.get('k1')).toBeNull()
  })

  it('key TTL is fixed from first creation, not reset on replay', async () => {
    await store.setIfAbsent('k1', { status: 'pending', bodyHash: 'abc' }, 50)
    await new Promise(r => setTimeout(r, 30))
    // Simulate replay — overwrite with complete
    await store.set('k1', { status: 'complete', bodyHash: 'abc', statusCode: 200, headers: {}, body: 'ok' }, 50)
    await new Promise(r => setTimeout(r, 40))
    // Original TTL would have expired by now (30+40 > 50)
    expect(await store.get('k1')).toBeNull()
  })
})

describe('idempotentKey with Redis store', () => {
  let redis: Redis
  let store: ReturnType<typeof redisStore>

  beforeAll(async () => {
    redis = new Redis(REDIS_URL)
    store = redisStore(redis)
  })

  afterAll(async () => {
    await redis.quit()
  })

  beforeEach(async () => {
    await redis.flushdb()
  })

  it('completes first request and stores response', async () => {
    let called = 0
    const h = async () => { called++; return { statusCode: 200, headers: {} as Record<string, string>, body: 'ok' } }
    const result = await processIdempotentKey('k1', new Uint8Array(), h, store, 60_000)
    expect(result.status).toBe('completed')
    expect(called).toBe(1)
  })

  it('replays cached response on duplicate', async () => {
    const h = async () => ({ statusCode: 200, headers: {} as Record<string, string>, body: 'ok' })
    await processIdempotentKey('k1', new Uint8Array(), h, store, 60_000)
    const result = await processIdempotentKey('k1', new Uint8Array(), h, store, 60_000)
    expect(result.status).toBe('replayed')
    expect(result.body).toBe('ok')
  })

  it('detects body hash mismatch and returns 409', async () => {
    const h = async () => ({ statusCode: 200, headers: {} as Record<string, string>, body: 'ok' })
    await processIdempotentKey('k1', new TextEncoder().encode('body1'), h, store, 60_000)
    const result = await processIdempotentKey('k1', new TextEncoder().encode('body2'), h, store, 60_000)
    expect(result.status).toBe('conflict')
    expect(result.statusCode).toBe(409)
  })

  it('100 concurrent requests produce exactly one handler execution', async () => {
    let handlerCalls = 0
    const handler = async () => { handlerCalls++; return { statusCode: 200, headers: {} as Record<string, string>, body: 'ok' } }

    const promises = Array.from({ length: 100 }, () =>
      processIdempotentKey('load-key', new Uint8Array(), handler, store, 60_000)
    )
    await Promise.all(promises)
    expect(handlerCalls).toBe(1)
  })
})

}
