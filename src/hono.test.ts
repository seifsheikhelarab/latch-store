import { describe, it, expect } from 'bun:test'
import { Hono } from 'hono'
import { idempotent } from './index'
import { memoryStore } from './memory-store'
import type { IdempotencyEvent } from './types'

describe('hono integration', () => {
  it('passes through when no idempotency key', async () => {
    const store = memoryStore()
    const app = new Hono()
    let called = false
    app.post('/test', idempotent.hono({ store }), (c) => {
      called = true
      return c.text('no key')
    })

    const res = await app.request('/test', { method: 'POST' })
    expect(called).toBe(true)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('no key')
  })

  it('first request completes and stores response', async () => {
    const store = memoryStore()
    const events: IdempotencyEvent[] = []
    const app = new Hono()
    let handlerCount = 0
    app.post('/test', idempotent.hono({ store, onEvent: (e) => events.push(e) }), (c) => {
      handlerCount++
      return c.text('first')
    })

    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k1' },
      body: 'hello',
    })

    expect(handlerCount).toBe(1)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('first')
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ type: 'key.created', key: 'k1' })
  })

  it('replay returns cached response without re-executing handler', async () => {
    const store = memoryStore()
    const events: IdempotencyEvent[] = []
    const app = new Hono()
    let handlerCount = 0
    app.post('/test', idempotent.hono({ store, onEvent: (e) => events.push(e) }), (c) => {
      handlerCount++
      return c.text('charged')
    })

    const res1 = await app.request('/test', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k2' },
      body: 'same',
    })
    expect(res1.status).toBe(200)
    expect(await res1.text()).toBe('charged')

    const res2 = await app.request('/test', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k2' },
      body: 'same',
    })

    expect(handlerCount).toBe(1)
    expect(res2.status).toBe(200)
    expect(await res2.text()).toBe('charged')
    expect(events).toHaveLength(2)
    expect(events[1]).toEqual({ type: 'key.replayed', key: 'k2' })
  })

  it('body mismatch returns 409', async () => {
    const store = memoryStore()
    const app = new Hono()
    app.post('/test', idempotent.hono({ store }), (c) => c.text('ok'))

    const res1 = await app.request('/test', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k3' },
      body: 'body-a',
    })
    expect(res1.status).toBe(200)

    const res2 = await app.request('/test', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k3' },
      body: 'body-b',
    })

    expect(res2.status).toBe(409)
  })

  it('preserves response body on replay', async () => {
    const store = memoryStore()
    const app = new Hono()
    app.post('/test', idempotent.hono({ store }), (c) => c.json({ id: 42, ok: true }))

    const res1 = await app.request('/test', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k4' },
      body: 'data',
    })
    const firstText = await res1.text()

    const res2 = await app.request('/test', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k4' },
      body: 'data',
    })
    const secondText = await res2.text()

    expect(firstText).toBe(secondText)
    expect(res2.headers.get('content-type')).toMatch(/^application\/json/)
  })
})
