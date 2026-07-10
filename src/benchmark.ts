import { performance } from "node:perf_hooks"
import { memoryStore } from "./memory-store.js"
import { processIdempotentKey, parseTTL } from "./core.js"

const ITERATIONS = 1000
const WARMUP = 100

function handler200() {
  return Promise.resolve({ statusCode: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' })
}

async function warmup(fn: () => Promise<void>): Promise<void> {
  for (let i = 0; i < WARMUP; i++) await fn()
}

async function bench(name: string, fn: () => Promise<void>): Promise<void> {
  await warmup(fn)
  const start = performance.now()
  for (let i = 0; i < ITERATIONS; i++) await fn()
  const elapsed = performance.now() - start
  const ops = (ITERATIONS / (elapsed / 1000)).toFixed(0)
  const avg = (elapsed / ITERATIONS).toFixed(3)
  console.log(`${"  " + name.padEnd(45)} ${ops.padStart(8)} ops/s  ${avg.padStart(8)} ms/op`)
}

console.log("\n  Benchmark                            ops/s        ms/op")
console.log("  " + "-".repeat(70))

await bench("parseTTL('24h')", async () => { parseTTL("24h") })

await bench("store.setIfAbsent (miss)", async () => {
  const s = memoryStore()
  await s.setIfAbsent("x", { status: "pending", bodyHash: "a" }, 60000)
})

await bench("store.get (hit)", async () => {
  const s = memoryStore()
  await s.setIfAbsent("x", { status: "complete", bodyHash: "a", statusCode: 200, headers: {}, body: "" }, 60000)
  await s.get("x")
})

await bench("store.get (miss)", async () => {
  await memoryStore().get("missing")
})

await bench("first request (empty body)", async () => {
  await processIdempotentKey("k-" + Math.random(), new Uint8Array(0), handler200, memoryStore(), 60000)
})

await bench("first request (1 KB body)", async () => {
  const body = new Uint8Array(1024); body.fill(65)
  await processIdempotentKey("k-" + Math.random(), body, handler200, memoryStore(), 60000)
})

await bench("first request (100 KB body)", async () => {
  const body = new Uint8Array(1024 * 100); body.fill(65)
  await processIdempotentKey("k-" + Math.random(), body, handler200, memoryStore(), 60000)
})

await bench("replay (cached response)", async () => {
  const s = memoryStore()
  await processIdempotentKey("k", new Uint8Array(0), handler200, s, 60000)
  await processIdempotentKey("k", new Uint8Array(0), handler200, s, 60000)
})

await bench("conflict (body mismatch)", async () => {
  const s = memoryStore()
  await processIdempotentKey("k", new Uint8Array([1]), handler200, s, 60000)
  await processIdempotentKey("k", new Uint8Array([2]), handler200, s, 60000)
})

// ── Concurrent ────────────────────────────────────────────────────

console.log(`\n  Contention (all 50 racing for 1 new key)`)
const contentionStore = memoryStore()
const contentionKey = "contention-" + Math.random()
const startCont = performance.now()
const contentionTasks = Array.from({ length: 50 }, () =>
  processIdempotentKey(contentionKey, new Uint8Array(0), handler200, contentionStore, 60000)
)
const contentionResults = await Promise.allSettled(contentionTasks)
const contentionElapsed = performance.now() - startCont
const completed = contentionResults.filter(r => r.status === "fulfilled" && r.value.status === "completed").length
const replayedCount = contentionResults.filter(r => r.status === "fulfilled" && r.value.status === "replayed").length
const conflictCount = contentionResults.filter(r => r.status === "fulfilled" && r.value.status === "conflict").length
const failed = contentionResults.filter(r => r.status === "rejected").length
console.log(`  ${"  throughput (50 concurrent)".padEnd(45)} ${(50 / (contentionElapsed / 1000)).toFixed(0).padStart(8)} ops/s`)
console.log(`  ${"  completed / replayed / conflict / failed".padEnd(45)} ${completed} / ${replayedCount} / ${conflictCount} / ${failed}`)
