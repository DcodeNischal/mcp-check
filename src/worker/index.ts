// The Worker: serves the API. Static files (the app) are served by Cloudflare before this runs.
import { Hono } from 'hono'
import { runTool } from '../checks/call'
import { runCheck } from '../checks/run'
import type { Exchange } from '../mcp/types'
import { gradeBadge, unknownBadge } from './badge'
import { canonicalUrl, loadGrade, loadReport, saveReport, serverId, signReport, touch, verifyReceipt } from './store'
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
  // A signed copy the visitor can hand back to /api/share: proof this Worker produced the grade.
  const receipt = report.connected || report.auth ? await signReport(c.env.DB, report) : undefined
  return c.json({ ok: true, report, log: trimLog(log), receipt }, 200, { 'Cache-Control': 'no-store' })
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

app.post('/api/share', async (c) => {
  const ip = c.req.header('CF-Connecting-IP')
  const { success } = await c.env.CHECK_LIMITER.limit({ key: ip ?? 'unknown' })
  if (!success) return c.json({ ok: false, error: 'rate-limited', message: 'Too many requests. Try again in a minute.' }, 429)
  const body = (await c.req.json().catch(() => null)) as { receipt?: unknown } | null
  const verified = await verifyReceipt(c.env.DB, body?.receipt)
  if (!verified.ok) return c.json({ ok: false, error: 'invalid', message: verified.reason }, 400)
  const report = verified.report
  if (!report.connected && !report.auth) return c.json({ ok: false, error: 'invalid', message: "Reports for servers that couldn't be reached can't be shared." }, 400)
  const canonical = canonicalUrl(report.url)
  if (!canonical.ok) return c.json({ ok: false, error: 'invalid', message: canonical.reason }, 400)
  const id = await serverId(canonical.url)
  await saveReport(c.env.DB, id, canonical.url, report)
  const origin = new URL(c.req.url).origin
  return c.json({ ok: true, id, reportUrl: `${origin}/r/${id}`, badgeUrl: `${origin}/badge/${id}.svg` })
})

app.get('/api/report/:id', async (c) => {
  const id = c.req.param('id')
  if (!ID.test(id)) return c.json({ ok: false, error: 'not-found' }, 404)
  const found = await loadReport(c.env.DB, id)
  if (!found) return c.json({ ok: false, error: 'not-found', message: 'No report with this id.' }, 404)
  c.executionCtx.waitUntil(touch(c.env.DB, found.meta).catch(() => {}))
  return c.json({ ok: true, id, report: found.report }, 200, { 'Cache-Control': 'public, max-age=60' })
})

app.all('/api/*', (c) => c.json({ ok: false, error: 'not-found' }, 404))

// README badge. GitHub caches images through its own proxy, so this is fetched rarely.
app.get('/badge/:file', async (c) => {
  const id = c.req.param('file').replace(/\.svg$/, '')
  const row = ID.test(id) ? await loadGrade(c.env.DB, id) : undefined
  const svg = row ? gradeBadge(row.grade, row.score, !!row.partial) : unknownBadge()
  return c.body(svg, 200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600, s-maxage=3600' })
})

// Shared report pages: the app, with a title and share-preview tags for this report.
app.get('/r/:id', async (c) => {
  const id = c.req.param('id')
  const page = await c.env.ASSETS.fetch(new Request(new URL('/', c.req.url)))
  const found = ID.test(id) ? await loadReport(c.env.DB, id).catch(() => undefined) : undefined
  if (!found) return new Response(page.body, { status: 404, headers: page.headers })

  const { report } = found
  const origin = new URL(c.req.url).origin
  const name = report.serverInfo?.title ?? report.serverInfo?.name ?? new URL(report.url).hostname
  const problems = report.checks.filter((x) => x.status === 'fail' || x.status === 'warn').length
  const title = `${name}: grade ${report.grade} (${report.score}/100) · MCP Check`
  const description = `${report.partial ? 'Partial grade (sign-in needed for tools). ' : ''}${report.tools.length} tools · spec ${report.version ?? 'unknown'} · ${problems ? `${problems} thing${problems === 1 ? '' : 's'} to fix` : 'no issues found'}. Checked ${report.checkedAt.slice(0, 10)}.`
  const meta: [string, string, string][] = [
    ['name', 'description', description],
    ['property', 'og:type', 'website'],
    ['property', 'og:site_name', 'MCP Check'],
    ['property', 'og:title', title],
    ['property', 'og:description', description],
    ['property', 'og:url', `${origin}/r/${id}`],
    ['property', 'og:image', `${origin}/og/grade-${report.grade}.png`],
    ['property', 'og:image:width', '1200'],
    ['property', 'og:image:height', '630'],
    ['name', 'twitter:card', 'summary_large_image'],
  ]
  const tags = meta.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${escapeAttr(value)}">`).join('') + `<link rel="canonical" href="${origin}/r/${id}">`
  const rewritten = new HTMLRewriter()
    .on('title', { element: (el) => { el.setInnerContent(title) } })
    // Drop the home page's own description and preview tags; this report's replace them.
    .on('meta[name="description"], meta[property^="og:"], meta[name^="twitter:"], link[rel="canonical"]', { element: (el) => { el.remove() } })
    .on('head', { element: (el) => { el.append(tags, { html: true }) } })
    .transform(new Response(page.body, page))
  const headers = new Headers(rewritten.headers)
  headers.set('Cache-Control', 'public, max-age=60')
  return new Response(rewritten.body, { status: 200, headers })
})

/** Keep the raw log useful but bounded: oversized message bodies become a preview. */
const ID = /^[a-z2-9]{12}$/

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}

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
