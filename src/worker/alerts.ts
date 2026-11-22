// Alerts for directory servers: an Atom feed for the whole directory and one per server, and
// webhooks a visitor can subscribe to a server. Events are recorded by triggers on the servers
// table (see MIGRATIONS in store.ts), and each event queues a delivery for every active webhook on
// that server, sent a few at a time by the cron run.
import { USER_AGENT } from '../mcp/wire'
import { checkTarget } from '../security/target'
import { ensureSchema } from './store'

export type EventType = 'listed' | 'grade_changed' | 'unreachable'

export interface ServerEvent {
  seq: number
  server_id: string
  type: EventType
  grade: string | null
  prev_grade: string | null
  score: number | null
  prev_score: number | null
  at: string
  name: string | null
  url: string
}

export type WebhookFormat = 'json' | 'slack' | 'discord'

const MAX_WEBHOOKS_PER_SERVER = 5
/** Retry delays after a failed delivery; after the last one the delivery is dropped. */
const RETRY_MINUTES = [5, 30, 120]
/** A webhook is switched off after this many dropped deliveries in a row. */
const MAX_WEBHOOK_FAILURES = 10
const EVENT_RETENTION_DAYS = 180

// --- text ------------------------------------------------------------------------------------

const label = (e: Pick<ServerEvent, 'name' | 'url'>) => e.name || new URL(e.url).hostname

/** One line describing an event, for feeds, Slack and Discord. */
export function eventText(e: ServerEvent): string {
  switch (e.type) {
    case 'listed':
      return `${label(e)} was added to the directory with grade ${e.grade} (${e.score}/100)`
    case 'grade_changed': {
      const better = (e.prev_grade ?? 'F') > (e.grade ?? 'F')
      return `${label(e)} ${better ? 'improved' : 'dropped'} from ${e.prev_grade} to ${e.grade} (${e.prev_score} → ${e.score}/100)`
    }
    case 'unreachable':
      return `${label(e)} stopped responding to weekly checks and was removed from the directory`
  }
}

export function webhookFormat(url: string): WebhookFormat {
  const u = new URL(url)
  if (u.hostname === 'hooks.slack.com') return 'slack'
  if ((u.hostname === 'discord.com' || u.hostname === 'discordapp.com') && u.pathname.startsWith('/api/webhooks/')) return 'discord'
  return 'json'
}

/** The request body for a delivery, in the webhook's format. */
export function webhookBody(format: WebhookFormat, e: ServerEvent | 'ping', origin: string, server: { id: string; url: string; name: string | null }): string {
  const reportUrl = `${origin}/r/${server.id}`
  if (e === 'ping') {
    const text = `MCP Check alerts are set up for ${label(server)}: ${reportUrl}`
    if (format === 'slack') return JSON.stringify({ text })
    if (format === 'discord') return JSON.stringify({ content: text, username: 'MCP Check' })
    return JSON.stringify({ type: 'ping', server: { id: server.id, url: server.url, name: server.name, reportUrl }, at: new Date().toISOString() })
  }
  const text = `${eventText(e)}: ${reportUrl}`
  if (format === 'slack') return JSON.stringify({ text })
  if (format === 'discord') return JSON.stringify({ content: text, username: 'MCP Check' })
  return JSON.stringify({
    type: e.type,
    server: { id: server.id, url: server.url, name: server.name, reportUrl },
    grade: e.grade,
    previousGrade: e.prev_grade,
    score: e.score,
    previousScore: e.prev_score,
    message: eventText(e),
    at: e.at,
  })
}

/** HMAC-SHA256 of the body with the webhook's secret, as hex. */
export async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// --- feeds -----------------------------------------------------------------------------------

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)

export function atomFeed(o: { origin: string; path: string; title: string; subtitle: string; link: string; events: ServerEvent[] }): string {
  const updated = o.events[0]?.at ?? new Date(0).toISOString()
  const entries = o.events.map((e) => {
    const link = `${o.origin}/r/${e.server_id}`
    return `  <entry>
    <id>tag:${new URL(o.origin).hostname},2026:event/${e.seq}</id>
    <title>${xml(eventText(e))}</title>
    <link href="${xml(link)}"/>
    <updated>${xml(e.at)}</updated>
    <summary>${xml(`${eventText(e)}. Server: ${e.url}`)}</summary>
  </entry>`
  })
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${xml(o.origin + o.path)}</id>
  <title>${xml(o.title)}</title>
  <subtitle>${xml(o.subtitle)}</subtitle>
  <link rel="self" href="${xml(o.origin + o.path)}"/>
  <link href="${xml(o.link)}"/>
  <updated>${xml(updated)}</updated>
  <author><name>MCP Check</name><uri>${xml(o.origin)}</uri></author>
${entries.join('\n')}
</feed>
`
}

export async function recentEvents(db: D1Database, serverId?: string, limit = 50): Promise<ServerEvent[]> {
  await ensureSchema(db)
  const { results } = await db
    .prepare(`SELECT e.seq, e.server_id, e.type, e.grade, e.prev_grade, e.score, e.prev_score, e.at, s.name, s.url
              FROM events e JOIN servers s ON s.id = e.server_id
              WHERE s.blocked = 0 ${serverId ? 'AND e.server_id = ?2' : ''}
              ORDER BY e.seq DESC LIMIT ?1`)
    .bind(...(serverId ? [limit, serverId] : [limit]))
    .all<ServerEvent>()
  return results
}

// --- webhooks --------------------------------------------------------------------------------

export class WebhookError extends Error {}

const randomSecret = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return 'whsec_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function post(url: string, body: string, headers: Record<string, string>, fetchImpl: typeof fetch): Promise<number | undefined> {
  if (!checkTarget(url).ok) return undefined
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, ...headers },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  await res?.body?.cancel().catch(() => {})
  return res?.status
}

/** Subscribe a webhook to a listed server. It must accept a test ping first. */
export async function subscribe(db: D1Database, serverId: string, url: string, origin: string, fetchImpl: typeof fetch = fetch): Promise<{ id: string; secret: string; format: WebhookFormat }> {
  await ensureSchema(db)
  if (!checkTarget(url).ok) throw new WebhookError('Webhook URLs must be public https:// addresses.')
  if (url.length > 1000) throw new WebhookError('That URL is too long.')
  const server = await db.prepare(`SELECT id, url, name FROM servers WHERE id = ?1 AND listed = 1 AND blocked = 0`).bind(serverId).first<{ id: string; url: string; name: string | null }>()
  if (!server) throw new WebhookError('Alerts are only available for servers listed in the directory.')
  const count = await db.prepare(`SELECT COUNT(*) AS n FROM webhooks WHERE server_id = ?1 AND active = 1`).bind(serverId).first<number>('n')
  if ((count ?? 0) >= MAX_WEBHOOKS_PER_SERVER) throw new WebhookError(`This server already has ${MAX_WEBHOOKS_PER_SERVER} webhooks.`)

  const format = webhookFormat(url)
  const secret = randomSecret()
  const id = crypto.randomUUID()
  const body = webhookBody(format, 'ping', origin, server)
  const status = await post(url, body, { 'X-MCP-Check-Event': 'ping', 'X-MCP-Check-Signature': `sha256=${await sign(secret, body)}` }, fetchImpl)
  if (!status || status < 200 || status >= 300) {
    throw new WebhookError(status ? `The test message got HTTP ${status}, so the webhook wasn't saved.` : "The test message couldn't be delivered, so the webhook wasn't saved.")
  }
  await db
    .prepare(`INSERT INTO webhooks (id, server_id, url, secret, format, active, failures, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, 0, ?6)`)
    .bind(id, serverId, url, secret, format, new Date().toISOString())
    .run()
  return { id, secret, format }
}

/** Unsubscribe with the secret given at subscription. */
export async function unsubscribe(db: D1Database, id: string, secret: string): Promise<boolean> {
  await ensureSchema(db)
  const row = await db.prepare(`SELECT secret FROM webhooks WHERE id = ?1`).bind(id).first<string>('secret')
  if (!row || !(await sameSecret(row, secret))) return false
  await db.batch([
    db.prepare(`DELETE FROM deliveries WHERE webhook_id = ?1`).bind(id),
    db.prepare(`DELETE FROM webhooks WHERE id = ?1`).bind(id),
  ])
  return true
}

/** Compare secrets without leaking how much matched. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))))
  let diff = 0
  for (let i = 0; i < x!.length; i++) diff |= x![i]! ^ y![i]!
  return diff === 0
}

/** Send due deliveries. Called from the cron run; returns how many were sent successfully. */
export async function deliverPending(db: D1Database, origin: string, limit = 10, fetchImpl: typeof fetch = fetch): Promise<number> {
  await ensureSchema(db)
  const now = new Date()
  const { results } = await db
    .prepare(`SELECT d.id AS delivery_id, d.attempts, w.id AS webhook_id, w.url AS webhook_url, w.secret, w.format,
                     e.seq, e.server_id, e.type, e.grade, e.prev_grade, e.score, e.prev_score, e.at, s.name, s.url
              FROM deliveries d JOIN webhooks w ON w.id = d.webhook_id JOIN events e ON e.seq = d.event_seq JOIN servers s ON s.id = e.server_id
              WHERE d.next_at <= ?1 AND w.active = 1 ORDER BY d.id LIMIT ?2`)
    .bind(now.toISOString(), limit)
    .all<ServerEvent & { delivery_id: number; attempts: number; webhook_id: string; webhook_url: string; secret: string; format: WebhookFormat }>()

  let sent = 0
  await Promise.all(results.map(async (d) => {
    const body = webhookBody(d.format, d, origin, { id: d.server_id, url: d.url, name: d.name })
    const status = await post(d.webhook_url, body, {
      'X-MCP-Check-Event': d.type,
      'X-MCP-Check-Delivery': String(d.delivery_id),
      'X-MCP-Check-Signature': `sha256=${await sign(d.secret, body)}`,
    }, fetchImpl)
    if (status && status >= 200 && status < 300) {
      sent++
      await db.batch([
        db.prepare(`DELETE FROM deliveries WHERE id = ?1`).bind(d.delivery_id),
        db.prepare(`UPDATE webhooks SET failures = 0, last_status = ?2 WHERE id = ?1`).bind(d.webhook_id, status),
      ])
      return
    }
    const retryIn = RETRY_MINUTES[d.attempts]
    if (retryIn !== undefined) {
      await db
        .prepare(`UPDATE deliveries SET attempts = attempts + 1, next_at = ?2 WHERE id = ?1`)
        .bind(d.delivery_id, new Date(now.getTime() + retryIn * 60_000).toISOString())
        .run()
      return
    }
    // Out of retries: drop it, and switch the webhook off after too many in a row.
    await db.batch([
      db.prepare(`DELETE FROM deliveries WHERE id = ?1`).bind(d.delivery_id),
      db.prepare(`UPDATE webhooks SET failures = failures + 1, last_status = ?2, active = CASE WHEN failures + 1 >= ?3 THEN 0 ELSE active END WHERE id = ?1`)
        .bind(d.webhook_id, status ?? 0, MAX_WEBHOOK_FAILURES),
    ])
  }))
  return sent
}

/** Forget events older than the retention period (feeds only show recent ones anyway). */
export async function pruneEvents(db: D1Database): Promise<void> {
  await db.prepare(`DELETE FROM events WHERE at < ?1`).bind(new Date(Date.now() - EVENT_RETENTION_DAYS * 86_400_000).toISOString()).run()
}
