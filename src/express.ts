import type { Store, CapturedResponse, IdempotencyEvent } from './types.js'
import { processIdempotentKey, parseTTL } from './core.js'

interface ExpressRequest {
  headers: Record<string, string | string[] | undefined>
  body?: unknown
  on: (event: 'data' | 'end', cb: (...args: any[]) => void) => void
}

interface ExpressResponse {
  status: (code: number) => ExpressResponse
  json: (body: unknown) => ExpressResponse
  send: (body: unknown) => ExpressResponse
  setHeader: (header: string, value: string) => void
  headersSent: boolean
}

type ExpressNext = (err?: unknown) => void

export interface IdempotentExpressOptions {
  store: Store
  ttl?: string
  onEvent?: (event: IdempotencyEvent) => void
}

/**
 * Express middleware that makes a route handler idempotent.
 *
 * Reads the `Idempotency-Key` header, buffers the request body, and delegates
 * to the core idempotency engine. If no key is present the middleware is a no-op.
 *
 * @example
 * ```ts
 * import { idempotentExpress, memoryStore } from 'latch-store'
 * const store = memoryStore()
 * app.post('/charge', idempotentExpress({ store }), handler)
 * ```
 */
export function idempotentExpress(options: IdempotentExpressOptions) {
  const ttlMs = options.ttl ? parseTTL(options.ttl) : 0

  return async (req: ExpressRequest, res: ExpressResponse, next: ExpressNext): Promise<void> => {
    const keyHeader = req.headers['idempotency-key']
    const key = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader
    if (!key) { next(); return }

    const bodyBytes = await bufferRequestBody(req)

    const result = await processIdempotentKey(
      key,
      bodyBytes,
      () => captureExpressResponse(res, next),
      options.store,
      ttlMs,
      options.onEvent,
    )

    if (!res.headersSent) {
      for (const [header, value] of Object.entries(result.headers)) {
        res.setHeader(header, value)
      }
      res.status(result.statusCode).send(result.body)
    }
  }
}

function bufferRequestBody(req: ExpressRequest): Promise<Uint8Array> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      if (chunks.length > 0) {
        resolve(new Uint8Array(Buffer.concat(chunks)))
      } else if (req.body !== undefined) {
        if (Buffer.isBuffer(req.body)) resolve(new Uint8Array(req.body))
        else if (typeof req.body === 'string') resolve(new TextEncoder().encode(req.body))
        else resolve(new TextEncoder().encode(JSON.stringify(req.body)))
      } else {
        resolve(new Uint8Array())
      }
    })
  })
}

function captureExpressResponse(res: ExpressResponse, next: ExpressNext): Promise<CapturedResponse> {
  return new Promise(resolve => {
    const originalSend = res.send.bind(res)
    const originalJson = res.json.bind(res)
    const originalStatus = res.status.bind(res)

    let capturedStatusCode = 200
    let capturedHeaders: Record<string, string> = {}
    let capturedBody = ''

    res.status = function (code: number) {
      capturedStatusCode = code
      return originalStatus(code)
    } as typeof res.status

    res.json = function (body: unknown) {
      capturedBody = JSON.stringify(body)
      capturedHeaders['content-type'] = 'application/json'
      return originalJson(body)
    } as typeof res.json

    res.send = function (body: unknown) {
      capturedBody = typeof body === 'string' ? body : JSON.stringify(body)
      resolve({ statusCode: capturedStatusCode, headers: capturedHeaders, body: capturedBody })
      return originalSend(body)
    } as typeof res.send

    next()
  })
}


