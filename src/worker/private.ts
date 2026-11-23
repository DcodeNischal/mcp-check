// Reports made with a token or custom headers can show tools the public can't see, so they're never
// stored under a server's guessable /r/<id> page. Sharing one gives a random, unguessable /p/<id>
// link instead, hidden from search engines, which expires after 30 days.
import type { Report } from '../checks/types'
import { ensureSchema, gunzip, gzip } from './store'

export const PRIVATE_TTL_DAYS = 30
export const PRIVATE_ID = /^[0-9a-f]{32}$/

export async function savePrivateReport(db: D1Database, url: string, report: Report): Promise<{ id: string; expiresAt: string }> {
  await ensureSchema(db)
  // 122 random bits: unguessable, unlike the /r/<id> of a public report (a hash of its URL).
  const id = crypto.randomUUID().replace(/-/g, '')
  const now = new Date()
  await db
    .prepare(`INSERT INTO private_reports (id, url, report, created_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(id, url, await gzip(JSON.stringify({ ...report, url })), now.toISOString())
    .run()
  return { id, expiresAt: new Date(now.getTime() + PRIVATE_TTL_DAYS * 86_400_000).toISOString() }
}

export async function loadPrivateReport(db: D1Database, id: string): Promise<{ report: Report; expiresAt: string } | undefined> {
  if (!PRIVATE_ID.test(id)) return undefined
  await ensureSchema(db)
  const row = await db.prepare(`SELECT report, created_at FROM private_reports WHERE id = ?1`).bind(id).first<{ report: ArrayBuffer | number[]; created_at: string }>()
  if (!row) return undefined
  const expiresAt = new Date(Date.parse(row.created_at) + PRIVATE_TTL_DAYS * 86_400_000).toISOString()
  if (Date.parse(expiresAt) < Date.now()) return undefined
  const bytes = row.report instanceof ArrayBuffer ? new Uint8Array(row.report) : Uint8Array.from(row.report)
  return { report: JSON.parse(await gunzip(bytes)) as Report, expiresAt }
}

export async function purgeExpiredPrivateReports(db: D1Database): Promise<void> {
  await db.prepare(`DELETE FROM private_reports WHERE created_at < ?1`).bind(new Date(Date.now() - PRIVATE_TTL_DAYS * 86_400_000).toISOString()).run()
}
