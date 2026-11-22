// The Worker: serves the API. Static files (the app) are served by Cloudflare before this runs.
import { Hono } from 'hono'
import { runTool } from '../checks/call'
import { runCheck } from '../checks/run'
import type { Exchange } from '../mcp/types'
import { verifyTurnstile, type TurnstileEnv } from './turnstile'

export interface Env extends TurnstileEnv {
  /** Local development only: skip Turnstile, and only when the request host is localhost. */
  DEV_SKIP_TURNSTILE?: string
  DB: D1Database
  CHECK_LIMITER: RateLimit
  ASSETS: Fetcher
}

const app = new Hono<{ Bindings: Env }>()
const VANTAGE = "Cloudflare's network"

app.get('/api/health', (c) => c.json({ ok: true }))

// Headers a visitor may pass through to the server they're checking (auth and custom API keys).
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'content-type', 'accept', 'origin', 'cookie', 'connection', 'transfer-encoding', 'mcp-session-id', 'mcp-protocol-version', 'mcp-method', 'mcp-name'])

function passThroughHeaders(input: unknown): Record<string, string> | string {
  if (input === undefined) return {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'headers must be an object'
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(input)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) return `Header "${name}" is not allowed.`
    if (typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) return `Header "${name}" has an invalid value.`
    out[name] = value
  }
  if (Object.keys(out).length > 10) return 'Too many headers (10 at most).'
  return out
}

/** Rate limit + Turnstile + body parsing shared by every endpoint that contacts a server. */
type GuardFail = { status: 400 | 403 | 429 | 500; error: string; message: string }
type GuardResult = { fail: GuardFail } | { fail?: undefined; body: Record<string, unknown>; headers: Record<string, string> }

async function guard(c: { req: { url: string; header(n: string): string | undefined; json(): Promise<unknown> }; env: Env }, action: string): Promise<GuardResult> {
  const ip = c.req.header('CF-Connecting-IP')
  const { success } = await c.env.CHECK_LIMITER.limit({ key: ip ?? 'unknown' })
  if (!success) return { fail: { status: 429, error: 'rate-limited', message: 'Too many requests from your network. Try again in a minute.' } }

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || typeof body.url !== 'string' || body.url.length > 2048) {
    return { fail: { status: 400, error: 'bad-request', message: 'Send { "url": "https://…" }.' } }
  }
  const host = new URL(c.req.url).hostname
  const devSkip = c.env.DEV_SKIP_TURNSTILE === '1' && (host === 'localhost' || host === '127.0.0.1')
  const human = devSkip ? ({ ok: true } as const) : await verifyTurnstile(body.token, ip, c.env, action)
  if (!human.ok) {
    console.warn('turnstile rejected', human.reason)
    return { fail: { status: human.reason === 'not-configured' ? 500 : 403, error: 'verification', message: "We couldn't confirm you're human. Please try again." } }
  }
  const headers = passThroughHeaders(body.headers)
  if (typeof headers === 'string') return { fail: { status: 400, error: 'bad-request', message: headers } }
  return { body, headers }
}

app.post('/api/check', async (c) => {
  const g = await guard(c, 'check')
  if (g.fail) return c.json({ ok: false, error: g.fail.error, message: g.fail.message }, g.fail.status)
  const log: Exchange[] = []
  const report = await runCheck(g.body.url as string, { headers: g.headers, vantage: VANTAGE, logSink: log })
  return c.json({ ok: true, report, log: trimLog(log) }, 200, { 'Cache-Control': 'no-store' })
})

app.post('/api/call', async (c) => {
  const g = await guard(c, 'call')
  if (g.fail) return c.json({ ok: false, error: g.fail.error, message: g.fail.message }, g.fail.status)
  const { tool, arguments: args } = g.body as { tool?: unknown; arguments?: unknown }
  if (typeof tool !== 'string' || !tool || tool.length > 256) return c.json({ ok: false, error: 'bad-request', message: 'Send the tool name.' }, 400)
  if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args))) return c.json({ ok: false, error: 'bad-request', message: 'Arguments must be an object.' }, 400)
  const outcome = await runTool(g.body.url as string, tool, (args ?? {}) as Record<string, unknown>, { headers: g.headers })
  return c.json({ ...outcome, log: trimLog(outcome.log) }, 200, { 'Cache-Control': 'no-store' })
})

app.all('/api/*', (c) => c.json({ ok: false, error: 'not-found' }, 404))

/** Keep the raw log useful but bounded: oversized message bodies become a preview. */
function trimLog(log: Exchange[]): Exchange[] {
  const PER_MESSAGE = 64 * 1024
  return log.map((e) => ({
    ...e,
    messages: e.messages.map((m) => {
      const text = JSON.stringify(m)
      return text.length > PER_MESSAGE ? { truncated: true, bytes: text.length, preview: text.slice(0, 2000) } : m
    }),
  }))
}

export default app
