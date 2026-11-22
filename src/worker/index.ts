// The Worker: serves the API. Static files (the app) are served by Cloudflare before this runs.
import { Hono } from 'hono'
import { runTool } from '../checks/call'
import { runCheck } from '../checks/run'
import type { Exchange } from '../mcp/types'
import { gradeBadge, unknownBadge } from './badge'
import { blockServer, canonicalUrl, dueForRecheck, listedIds, listServers, loadGrade, loadReport, PAGE_SIZE, recordFailure, saveReport, serverId, serverUrl, signReport, touch, verifyReceipt } from './store'
import { checkTarget } from '../security/target'
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
  const body = (await c.req.json().catch(() => null)) as { receipt?: unknown; list?: unknown } | null
  const verified = await verifyReceipt(c.env.DB, body?.receipt)
  if (!verified.ok) return c.json({ ok: false, error: 'invalid', message: verified.reason }, 400)
  const report = verified.report
  if (!report.connected && !report.auth) return c.json({ ok: false, error: 'invalid', message: "Reports for servers that couldn't be reached can't be shared." }, 400)
  const canonical = canonicalUrl(report.url)
  if (!canonical.ok) return c.json({ ok: false, error: 'invalid', message: canonical.reason }, 400)
  const id = await serverId(canonical.url)
  const saved = await saveReport(c.env.DB, id, canonical.url, report, { list: body?.list === true })
  const origin = new URL(c.req.url).origin
  return c.json({ ok: true, id, reportUrl: `${origin}/r/${id}`, badgeUrl: `${origin}/badge/${id}.svg`, listed: saved.listed, blocked: saved.blocked })
})

app.get('/api/report/:id', async (c) => {
  const id = c.req.param('id')
  if (!ID.test(id)) return c.json({ ok: false, error: 'not-found' }, 404)
  const found = await loadReport(c.env.DB, id)
  if (!found) return c.json({ ok: false, error: 'not-found', message: 'No report with this id.' }, 404)
  c.executionCtx.waitUntil(touch(c.env.DB, found.meta).catch(() => {}))
  return c.json({ ok: true, id, report: found.report, listed: !!found.meta.listed, blocked: !!found.meta.blocked }, 200, { 'Cache-Control': 'public, max-age=60' })
})

// The public directory: listed servers, searchable and filterable.
app.get('/api/servers', async (c) => {
  const search = (c.req.query('q') ?? '').trim().slice(0, 100)
  const grade = (c.req.query('grade') ?? '').toUpperCase()
  const sort = c.req.query('sort') === 'recent' ? 'recent' : 'grade'
  const page = Math.min(1000, Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1))
  const result = await listServers(c.env.DB, { search, sort, page, ...(/^[ABCDF]$/.test(grade) ? { grade } : {}) })
  return c.json({ ok: true, ...result, page, pageSize: PAGE_SIZE }, 200, { 'Cache-Control': 'public, max-age=60' })
})

// Owner removal: the server's domain must serve /.well-known/mcp-check.txt containing
// "mcp-check: remove <id>". Then the server is unlisted and can't be listed again.
app.post('/api/unlist', async (c) => {
  const ip = c.req.header('CF-Connecting-IP')
  const { success } = await c.env.CHECK_LIMITER.limit({ key: ip ?? 'unknown' })
  if (!success) return c.json({ ok: false, error: 'rate-limited', message: 'Too many requests. Try again in a minute.' }, 429)
  const body = (await c.req.json().catch(() => null)) as { id?: unknown } | null
  const id = typeof body?.id === 'string' ? body.id : ''
  if (!ID.test(id)) return c.json({ ok: false, error: 'not-found', message: 'No server with this id.' }, 404)
  const url = await serverUrl(c.env.DB, id)
  if (!url) return c.json({ ok: false, error: 'not-found', message: 'No server with this id.' }, 404)

  const proofUrl = `${new URL(url).origin}/.well-known/mcp-check.txt`
  if (!checkTarget(proofUrl).ok) return c.json({ ok: false, error: 'invalid', message: 'This server cannot be verified.' }, 400)
  let text = ''
  try {
    const res = await fetch(proofUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    text = res.ok ? (await res.text()).slice(0, 4096) : ''
  } catch {
    text = ''
  }
  if (!new RegExp(`mcp-check:\\s*remove\\s+${id}\\b`).test(text)) {
    return c.json({ ok: false, error: 'unverified', message: `Couldn't find "mcp-check: remove ${id}" at ${proofUrl}.` }, 400)
  }
  await blockServer(c.env.DB, id)
  return c.json({ ok: true, message: 'Removed from the directory. It will not be listed again.' })
})

app.all('/api/*', (c) => c.json({ ok: false, error: 'not-found' }, 404))

app.get('/sitemap.xml', async (c) => {
  const origin = new URL(c.req.url).origin
  const servers = await listedIds(c.env.DB)
  const urls = [
    `<url><loc>${origin}/</loc></url>`,
    `<url><loc>${origin}/servers</loc></url>`,
    ...servers.map((s) => `<url><loc>${origin}/r/${s.id}</loc><lastmod>${s.checked_at.slice(0, 10)}</lastmod></url>`),
  ]
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`
  return c.body(xml, 200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' })
})

app.get('/servers', async (c) => {
  const origin = new URL(c.req.url).origin
  return withMeta(c.env, c.req.url, {
    title: 'MCP server directory: graded public MCP servers · MCP Check',
    description: 'Browse public MCP servers graded A to F on spec compliance, tool quality, OAuth, security and speed. Re-checked every week.',
    url: `${origin}/servers`,
    image: `${origin}/og.png`,
  })
})

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
  return withMeta(c.env, c.req.url, { title, description, url: `${origin}/r/${id}`, image: `${origin}/og/grade-${report.grade}.png` })
})

const ID = /^[a-z2-9]{12}$/

/** The app's HTML with a page-specific title, description and share-preview tags. */
async function withMeta(env: Env, requestUrl: string, m: { title: string; description: string; url: string; image: string }): Promise<Response> {
  const page = await env.ASSETS.fetch(new Request(new URL('/', requestUrl)))
  const meta: [string, string, string][] = [
    ['name', 'description', m.description],
    ['property', 'og:type', 'website'],
    ['property', 'og:site_name', 'MCP Check'],
    ['property', 'og:title', m.title],
    ['property', 'og:description', m.description],
    ['property', 'og:url', m.url],
    ['property', 'og:image', m.image],
    ['property', 'og:image:width', '1200'],
    ['property', 'og:image:height', '630'],
    ['name', 'twitter:card', 'summary_large_image'],
  ]
  const tags = meta.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${escapeAttr(value)}">`).join('') + `<link rel="canonical" href="${escapeAttr(m.url)}">`
  const rewritten = new HTMLRewriter()
    .on('title', { element: (el) => { el.setInnerContent(m.title) } })
    // Drop the home page's own description and preview tags; these replace them.
    .on('meta[name="description"], meta[property^="og:"], meta[name^="twitter:"], link[rel="canonical"]', { element: (el) => { el.remove() } })
    .on('head', { element: (el) => { el.append(tags, { html: true }) } })
    .transform(new Response(page.body, page))
  const headers = new Headers(rewritten.headers)
  headers.set('Cache-Control', 'public, max-age=60')
  return new Response(rewritten.body, { status: 200, headers })
}

// Re-check listed servers whose report is over a week old: one per run (every 10 minutes),
// which keeps each run well inside the free plan's limits. Three failures in a row unlist a server.
async function recheck(env: Env) {
  const now = Date.now()
  const due = await dueForRecheck(env.DB, new Date(now - 7 * 86_400_000).toISOString(), new Date(now - 86_400_000).toISOString(), 1)
  for (const server of due) {
    const report = await runCheck(server.url, { vantage: VANTAGE })
    if (report.connected || report.auth) await saveReport(env.DB, server.id, server.url, report)
    else await recordFailure(env.DB, server.id)
    console.log('recheck', server.id, report.connected || report.auth ? report.grade : 'unreachable')
  }
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}

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

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(recheck(env))
  },
} satisfies ExportedHandler<Env>
