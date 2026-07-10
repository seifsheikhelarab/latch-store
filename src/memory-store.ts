import type { Store, Entry } from './types.js'

const timers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Create an in-memory store adapter for idempotency entries.
 *
 * Useful for local development and tests. Not suitable for multi-process deployments.
 */
export function memoryStore(): Store {
  const data = new Map<string, Entry>()

  function scheduleExpiry(key: string, ttlMs: number): void {
    const existing = timers.get(key)
    if (existing) clearTimeout(existing)
    timers.set(key, setTimeout(() => { data.delete(key); timers.delete(key) }, ttlMs))
  }

  return {
    async setIfAbsent(key, value, ttlMs) {
      if (data.has(key)) return false
      data.set(key, value)
      scheduleExpiry(key, ttlMs)
      return true
    },

    async set(key, value, ttlMs) {
      data.set(key, value)
      scheduleExpiry(key, ttlMs)
    },

    async get(key) {
      return data.get(key) ?? null
    },

    async del(key) {
      data.delete(key)
      const timer = timers.get(key)
      if (timer) { clearTimeout(timer); timers.delete(key) }
    },
  }
}
