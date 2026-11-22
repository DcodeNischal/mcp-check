// Saved reports in D1: one row per server URL, gzip-compressed. Reports are only saved when a
// visitor shares one, and only if it carries a valid signature from this Worker, so nobody can
// upload a made-up grade.
import type { Report } from '../checks/types'

const MAX_RECEIPT_AGE_MS = 60 * 60 * 1000

let schemaReady: Promise<unknown> | undefined
export function ensureSchema(db: D1Database) {
  schemaReady ??= db
    .batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        name TEXT,
        version TEXT,
        grade TEXT NOT NULL,
        score INTEGER NOT NULL,
        era TEXT,
        spec_version TEXT,
        tools_count INTEGER NOT NULL DEFAULT 0,
        partial INTEGER NOT NULL DEFAULT 0,
        auth_required INTEGER NOT NULL DEFAULT 0,
        authenticated INTEGER NOT NULL DEFAULT 0,
        report BLOB NOT NULL,
        checked_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_viewed_at TEXT,
        listed INTEGER NOT NULL DEFAULT 0
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS servers_listed_grade ON servers (listed, grade, score DESC)`),
    ])
    .catch((err) => {
      schemaReady = undefined
      throw err
    })
  return schemaReady
}

// --- the signing key, created on first use and kept in D1 ----------------------------------

let keyPromise: Promise<CryptoKey> | undefined
function signingKey(db: D1Database): Promise<CryptoKey> {
  keyPromise ??= (async () => {
    await ensureSchema(db)
    let secret = await db.prepare(`SELECT value FROM settings WHERE key = 'report_key'`).first<string>('value')
    if (!secret) {
      const fresh = base64url(crypto.getRandomValues(new Uint8Array(32)))
      // If two requests race, INSERT OR IGNORE keeps the first; read back whichever won.
      await db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('report_key', ?)`).bind(fresh).run()
      secret = (await db.prepare(`SELECT value FROM settings WHERE key = 'report_key'`).first<string>('value')) ?? fresh
    }
    return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  })().catch((err) => {
    keyPromise = undefined
    throw err
  })
  return keyPromise
}

export interface Receipt {
  /** The report exactly as the Worker produced it, as a JSON string. */
  payload: string
  sig: string
}

export async function signReport(db: D1Database, report: Report): Promise<Receipt> {
  const payload = JSON.stringify(report)
  const sig = await crypto.subtle.sign('HMAC', await signingKey(db), new TextEncoder().encode(payload))
  return { payload, sig: base64url(new Uint8Array(sig)) }
}

export async function verifyReceipt(db: D1Database, receipt: unknown): Promise<{ ok: true; report: Report } | { ok: false; reason: string }> {
  if (!receipt || typeof receipt !== 'object') return { ok: false, reason: 'Missing report.' }
  const { payload, sig } = receipt as Partial<Receipt>
  if (typeof payload !== 'string' || typeof sig !== 'string' || payload.length > 2_000_000) return { ok: false, reason: 'Missing report.' }
  let raw: Uint8Array<ArrayBuffer>
  try {
    raw = fromBase64url(sig)
  } catch {
    return { ok: false, reason: 'This report could not be verified.' }
  }
  const valid = await crypto.subtle.verify('HMAC', await signingKey(db), raw, new TextEncoder().encode(payload))
  if (!valid) return { ok: false, reason: 'This report could not be verified.' }
  const report = JSON.parse(payload) as Report
  if (Date.now() - Date.parse(report.checkedAt) > MAX_RECEIPT_AGE_MS) return { ok: false, reason: 'This check is over an hour old. Run it again to share it.' }
  return { ok: true, report }
}

// --- ids and URLs --------------------------------------------------------------------------

/** The canonical form of a server URL: lowercase host, no default port, no trailing slash. */
export function canonicalUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, reason: 'Invalid URL.' }
  }
  if (u.search || u.hash) return { ok: false, reason: "URLs with query strings can't be shared, because they often contain API keys." }
  if (u.username || u.password) return { ok: false, reason: "URLs with credentials can't be shared." }
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : ''
  return { ok: true, url: `${u.protocol}//${u.host.toLowerCase()}${path}` }
}

/** A short, stable id per server, so sharing again updates the same report and badge. */
export async function serverId(url: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url)))
  return base32(hash).slice(0, 12)
}

// --- saving and loading ---------------------------------------------------------------------

export async function saveReport(db: D1Database, id: string, url: string, report: Report): Promise<void> {
  await ensureSchema(db)
  const blob = await gzip(JSON.stringify({ ...report, url }))
  const now = new Date().toISOString()
  await db
    .prepare(`INSERT INTO servers (id, url, name, version, grade, score, era, spec_version, tools_count, partial, auth_required, authenticated, report, checked_at, created_at, updated_at)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)
              ON CONFLICT (id) DO UPDATE SET name = ?3, version = ?4, grade = ?5, score = ?6, era = ?7, spec_version = ?8,
                tools_count = ?9, partial = ?10, auth_required = ?11, authenticated = ?12, report = ?13, checked_at = ?14, updated_at = ?15`)
    .bind(
      id, url,
      report.serverInfo?.title ?? report.serverInfo?.name ?? null,
      report.serverInfo?.version ?? null,
      report.grade, report.score, report.era ?? null, report.version ?? null,
      report.tools.length, report.partial ? 1 : 0, report.auth?.required ? 1 : 0, report.authenticated ? 1 : 0,
      blob, report.checkedAt, now,
    )
    .run()
}

export interface StoredServer {
  id: string
  url: string
  name: string | null
  grade: string
  score: number
  partial: number
  checked_at: string
  last_viewed_at: string | null
}

export async function loadReport(db: D1Database, id: string): Promise<{ meta: StoredServer; report: Report } | undefined> {
  await ensureSchema(db)
  const row = await db.prepare(`SELECT id, url, name, grade, score, partial, checked_at, last_viewed_at, report FROM servers WHERE id = ?`).bind(id).first<StoredServer & { report: ArrayBuffer | number[] }>()
  if (!row) return undefined
  const bytes = row.report instanceof ArrayBuffer ? new Uint8Array(row.report) : Uint8Array.from(row.report)
  const report = JSON.parse(await gunzip(bytes)) as Report
  const { report: _blob, ...meta } = row
  return { meta, report }
}

/** Grade only, for badges. */
export async function loadGrade(db: D1Database, id: string): Promise<{ grade: string; score: number; partial: number } | undefined> {
  await ensureSchema(db)
  return (await db.prepare(`SELECT grade, score, partial FROM servers WHERE id = ?`).bind(id).first<{ grade: string; score: number; partial: number }>()) ?? undefined
}

/** Remember that someone looked, at most once a day per report (used to expire unloved reports). */
export async function touch(db: D1Database, meta: StoredServer): Promise<void> {
  if (meta.last_viewed_at && Date.now() - Date.parse(meta.last_viewed_at) < 24 * 60 * 60 * 1000) return
  await db.prepare(`UPDATE servers SET last_viewed_at = ? WHERE id = ?`).bind(new Date().toISOString(), meta.id).run()
}

// --- encoding helpers -----------------------------------------------------------------------

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'
function base32(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return out
}
