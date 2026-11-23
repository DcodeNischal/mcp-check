// Reports made with a token or custom headers can show tools the public can't see, so they're never
// stored under a server's guessable /r/<id> page. Sharing one gives a random, unguessable /p/<id>
// link instead, hidden from search engines, which expires after 30 days.
import type { Report } from '../checks/types'
import { ensureSchema, gunzip, gzip } from './store'

export const PRIVATE_TTL_DAYS = 30
export const PRIVATE_ID = /^[0-9a-f]{32}$/

/** Stored reports are capped so sharing can't fill the database. */
export const PRIVATE_MAX_BYTES = 256 * 1024

export class PrivateReportTooLarge extends Error {}

/**
 * Save a private report under an id derived from its receipt signature (which only this Worker can
 * produce): unguessable, and sharing the same receipt again returns the same link and writes nothing.
 */
export async function savePrivateReport(db: D1Database, url: string, report: Report, receiptSig: string): Promise<{ id: string; expiresAt: string }> {
  await ensureSchema(db)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`private-report:${receiptSig}`)))
  const id = [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const blob = await gzip(JSON.stringify({ ...report, url }))
  if (blob.byteLength > PRIVATE_MAX_BYTES) throw new PrivateReportTooLarge('This report is too large to share privately.')
  const now = new Date()
  await db.prepare(`INSERT OR IGNORE INTO private_reports (id, url, report, created_at) VALUES (?1, ?2, ?3, ?4)`).bind(id, url, blob, now.toISOString()).run()
  const created = (await db.prepare(`SELECT created_at FROM private_reports WHERE id = ?1`).bind(id).first<string>('created_at')) ?? now.toISOString()
  return { id, expiresAt: new Date(Date.parse(created) + PRIVATE_TTL_DAYS * 86_400_000).toISOString() }
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
