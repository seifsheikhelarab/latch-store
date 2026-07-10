/**
 * Represents the state of an idempotency key entry in the store.
 */
export type EntryStatus = 'pending' | 'complete'

/**
 * The value stored for each idempotency key.
 *
 * - `status`: 'pending' while the handler is executing, 'complete' once done.
 * - `bodyHash`: SHA-256 hex digest of the key + request body concatenation.
 * - `statusCode`, `headers`, `body`: populated when status is 'complete'.
 */
export interface Entry {
  status: EntryStatus
  bodyHash: string
  statusCode?: number
  headers?: Record<string, string>
  body?: string
}

/**
 * Events emitted via the `onEvent` callback.
 */
export type IdempotencyEvent =
  | { type: 'key.created'; key: string }
  | { type: 'key.replayed'; key: string }
  | { type: 'key.conflict'; key: string }

/**
 * A persistent store for idempotency entries.
 *
 * Implementors must guarantee:
 * - `setIfAbsent` is atomic — concurrent calls with the same key do not both succeed.
 * - `get` returns null for expired or non-existent keys.
 */
export interface Store {
  /** Atomically set `value` for `key` only if absent. Returns true if this call created the entry. */
  setIfAbsent(key: string, value: Entry, ttlMs: number): Promise<boolean>
  /** Unconditionally overwrite `value` for `key`. */
  set(key: string, value: Entry, ttlMs: number): Promise<void>
  /** Read the entry for `key`. Returns null if missing or expired. */
  get(key: string): Promise<Entry | null>
  /** Delete the entry for `key`. No-op if missing. */
  del(key: string): Promise<void>
}

/**
 * The response captured from a completed handler execution.
 */
export interface CapturedResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
}

/**
 * The result returned from processing an idempotent request.
 */
export interface IdempotentResult {
  status: 'completed' | 'replayed' | 'conflict' | 'passthrough'
  statusCode: number
  headers: Record<string, string>
  body: string
}
