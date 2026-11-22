// The Worker: serves the API. Static files (the app) are served by Cloudflare before this runs.
import { Hono } from 'hono'
import { runCheck } from '../checks/run'

export interface Env {
  DB: D1Database
  CHECK_LIMITER: RateLimit
  ASSETS: Fetcher
}

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (c) => c.json({ ok: true }))

// Headers a visitor may pass through to the server they're checking (auth and custom API keys).
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'content-type', 'accept', 'origin', 'cookie', 'connection', 'transfer-encoding', 'mcp-session-id', 'mcp-protocol-version', 'mcp-method', 'mcp-name'])

function passThroughHeaders(input: unknown): Record<string, string> | string {
  if (input === undefined) return {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'headers must be an object'
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(input)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) return `header "${name}" is not allowed`
    if (typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) return `header "${name}" has an invalid value`
    out[name] = value
  }
  if (Object.keys(out).length > 10) return 'too many headers'
  return out
}

app.post('/api/check', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  const { success } = await c.env.CHECK_LIMITER.limit({ key: ip })
  if (!success) return c.json({ ok: false, error: 'rate-limited', message: 'Too many checks from your network. Try again in a minute.' }, 429)

  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || typeof (body as { url?: unknown }).url !== 'string') {
    return c.json({ ok: false, error: 'bad-request', message: 'Send { "url": "https://…" }.' }, 400)
  }
  const headers = passThroughHeaders((body as { headers?: unknown }).headers)
  if (typeof headers === 'string') return c.json({ ok: false, error: 'bad-request', message: headers }, 400)

  const report = await runCheck((body as { url: string }).url, { headers, vantage: "Cloudflare's network" })
  return c.json({ ok: true, report }, 200, { 'Cache-Control': 'no-store' })
})

app.all('/api/*', (c) => c.json({ ok: false, error: 'not-found' }, 404))

export default app
