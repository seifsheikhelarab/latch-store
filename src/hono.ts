import type { Store, CapturedResponse, IdempotencyEvent } from './types.js'
import { processIdempotentKey, parseTTL } from './core.js'

interface HonoContext {
  req: {
    header: (name: string) => string | undefined
    text: () => Promise<string>
  }
  res: Response
  newResponse: (body: string | null, status: number, headers: Record<string, string>) => Response
}

type HonoNext = () => Promise<void>

export interface IdempotentHonoOptions {
  store: Store
  ttl?: string
  onEvent?: (event: IdempotencyEvent) => void
}

/**
 * Hono middleware that makes a route handler idempotent.
 *
 * Reads the `Idempotency-Key` header, buffers the request body, and delegates
 * to the core idempotency engine. If no key is present the middleware is a no-op.
 *
 * @example
 * ```ts
 * import { idempotentHono, memoryStore } from 'latch-store'
 * const store = memoryStore()
 * app.post('/charge', idempotentHono({ store }), handler)
 * ```
 */
export function idempotentHono(options: IdempotentHonoOptions) {
  const ttlMs = options.ttl ? parseTTL(options.ttl) : 0

  return async (c: HonoContext, next: HonoNext): Promise<Response | void> => {
    const key = c.req.header('Idempotency-Key')
    if (!key) { return next() }

    const bodyBytes = await bufferHonoBody(c)

    const result = await processIdempotentKey(
      key,
      bodyBytes,
      async () => {
        await next()
        return await captureHonoResponse(c)
      },
      options.store,
      ttlMs,
      options.onEvent,
    )

    if (result.status === 'passthrough') return
    return c.newResponse(result.body, result.statusCode, result.headers)
  }
}

async function bufferHonoBody(c: HonoContext): Promise<Uint8Array> {
  const text = await c.req.text()
  return new TextEncoder().encode(text)
}

async function captureHonoResponse(c: HonoContext): Promise<CapturedResponse> {
  const clone = c.res.clone()
  const body = await clone.text()
  const statusCode = clone.status
  const headers: Record<string, string> = {}
  clone.headers.forEach((value, key) => { headers[key] = value })
  return { statusCode, headers, body }
}
