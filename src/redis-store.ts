import { Redis } from 'ioredis'
import type { Store, Entry } from './types.js'

/**
 * Create a Redis-backed store adapter for idempotency entries.
 *
 * Uses `SET NX PX` for atomic claim-and-lock and `SET KEEPTTL` for completion
 * (preserves the original TTL, not reset on replay).
 *
 * @param redis - An ioredis `Redis` instance. Must be connected before first use.
 *
 * @example
 * ```ts
 * import { Redis } from 'ioredis'
 * import { redisStore } from 'latch-store'
 * const store = redisStore(new Redis())
 * ```
 */
export function redisStore(redis: Redis): Store {
  return {
    async setIfAbsent(key, value, ttlMs) {
      const result = await redis.set(key, JSON.stringify(value), 'PX', ttlMs, 'NX')
      return result === 'OK'
    },

    async set(key, value, _ttlMs) {
      await redis.set(key, JSON.stringify(value), 'KEEPTTL')
    },

    async get(key) {
      const raw = await redis.get(key)
      if (!raw) return null
      return JSON.parse(raw) as Entry
    },

    async del(key) {
      await redis.del(key)
    },
  }
}
