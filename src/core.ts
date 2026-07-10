import type { Store, CapturedResponse, IdempotentResult, IdempotencyEvent } from './types.js'

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const POLL_INTERVAL_MS = 50
const POLL_TIMEOUT_MS = 30_000

function parseTTL(ttl: string): number {
  const match = ttl.match(/^(\d+)(h|m|d)$/)
  if (!match) throw new Error(`Invalid TTL format: "${ttl}". Use e.g. "24h", "30m", "7d".`)
  const value = Number.parseInt(match[1]!)
  const unit = match[2]!
  switch (unit) {
    case 'h': return value * 60 * 60 * 1000
    case 'm': return value * 60 * 1000
    case 'd': return value * 24 * 60 * 60 * 1000
    default: throw new Error(`Unexpected TTL unit: ${unit}`)
  }
}

async function hashBody(key: string, body: Uint8Array): Promise<string> {
  const encoder = new TextEncoder()
  const input = encoder.encode(key)
  const combined = new Uint8Array(input.length + body.length)
  combined.set(input)
  combined.set(body, input.length)
  const digest = await crypto.subtle.digest('SHA-256', combined)
  const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
  return hex
}

function emitEvent(onEvent: ((event: IdempotencyEvent) => void) | undefined, event: IdempotencyEvent): void {
  try {
    onEvent?.(event)
  } catch {
    // fire-and-forget, swallow callback errors
  }
}

/**
 * Process an idempotent request.
 *
 * Called by framework adapters once they have extracted the idempotency key and
 * buffered the request body. Returns a fully formed HTTP response.
 *
 * @param key - The idempotency key from the `Idempotency-Key` header.
 * @param bodyBytes - The raw request body bytes.
 * @param handler - The actual request handler to execute (once).
 * @param store - The store adapter for persisting idempotency state.
 * @param ttlMs - Key TTL in milliseconds. Defaults to 24h if 0.
 * @param onEvent - Optional callback for idempotency lifecycle events.
 */
export async function processIdempotentKey(
  key: string,
  bodyBytes: Uint8Array,
  handler: () => Promise<CapturedResponse>,
  store: Store,
  ttlMs: number = DEFAULT_TTL_MS,
  onEvent?: (event: IdempotencyEvent) => void,
): Promise<IdempotentResult> {
  const effectiveTtl = ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS
  const bodyHash = await hashBody(key, bodyBytes)

  try {
    const claimed = await store.setIfAbsent(key, { status: 'pending', bodyHash }, effectiveTtl)
    if (claimed) {
      emitEvent(onEvent, { type: 'key.created', key })
      return executeAndStore(key, handler, store, effectiveTtl, bodyHash)
    }

    return handleExistingKey(key, bodyHash, store, onEvent)
  } catch (err) {
    // Store error — degrade gracefully
    console.warn(`[latch-store] Store error for key "${key}":`, err)
    const result = await handler()
    return { status: 'passthrough', ...result }
  }
}

async function executeAndStore(
  key: string,
  handler: () => Promise<CapturedResponse>,
  store: Store,
  ttlMs: number,
  bodyHash: string,
): Promise<IdempotentResult> {
  try {
    const response = await handler()
    await store.set(key, { status: 'complete', bodyHash, ...response }, ttlMs)
    return { status: 'completed', ...response }
  } catch (err) {
    await store.del(key).catch(() => {})
    throw err
  }
}

async function handleExistingKey(
  key: string,
  bodyHash: string,
  store: Store,
  onEvent?: (event: IdempotencyEvent) => void,
): Promise<IdempotentResult> {
  const startTime = Date.now()
  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    const entry = await store.get(key)
    if (!entry) {
      // Key expired or deleted — treat as first sighting
      break
    }
    if (entry.bodyHash !== bodyHash) {
      emitEvent(onEvent, { type: 'key.conflict', key })
      return { status: 'conflict', statusCode: 409, headers: {}, body: JSON.stringify({ error: 'Idempotency key already used with a different request body' }) }
    }
    if (entry.status === 'complete' && entry.statusCode !== undefined) {
      emitEvent(onEvent, { type: 'key.replayed', key })
      return { status: 'replayed', statusCode: entry.statusCode, headers: entry.headers ?? {}, body: entry.body ?? '' }
    }
    await sleep(POLL_INTERVAL_MS)
  }

  // Timed out or key disappeared — re-execute
  emitEvent(onEvent, { type: 'key.conflict', key })
  return { status: 'conflict', statusCode: 409, headers: {}, body: JSON.stringify({ error: 'Timed out waiting for pending request' }) }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export { parseTTL }
