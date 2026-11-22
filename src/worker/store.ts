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
    .then(() => migrate(db))
    .catch((err) => {
      schemaReady = undefined
      throw err
    })
  return schemaReady
}

// Columns added after the first deploy. Each step runs once; "duplicate column" means another
// request already applied it, which is fine.
const MIGRATIONS: string[][] = [
  [
    `ALTER TABLE servers ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE servers ADD COLUMN failures INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE servers ADD COLUMN last_attempt_at TEXT`,
  ],
  [
    // Details from the official MCP Registry, shown on server pages.
    `ALTER TABLE servers ADD COLUMN registry_name TEXT`,
    `ALTER TABLE servers ADD COLUMN description TEXT`,
    `ALTER TABLE servers ADD COLUMN repository_url TEXT`,
    `ALTER TABLE servers ADD COLUMN website_url TEXT`,
    // Servers found in the registry, waiting to be checked.
    `CREATE TABLE IF NOT EXISTS registry (
      url TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      host TEXT NOT NULL,
      registry_name TEXT NOT NULL,
      title TEXT,
      description TEXT,
      version TEXT,
      repository_url TEXT,
      website_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS registry_pending ON registry (status, last_attempt_at)`,
  ],
]

async function migrate(db: D1Database) {
  const current = Number((await db.prepare(`SELECT value FROM settings WHERE key = 'schema_version'`).first<string>('value')) ?? 0)
  for (let v = current; v < MIGRATIONS.length; v++) {
    for (const sql of MIGRATIONS[v]!) {
      try {
        await db.prepare(sql).run()
      } catch (err) {
        if (!/duplicate column/i.test(String((err as Error)?.message ?? err))) throw err
      }
    }
    await db.prepare(`INSERT INTO settings (key, value) VALUES ('schema_version', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1`).bind(String(v + 1)).run()
  }
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

export interface RegistryDetails {
  registryName: string
  description: string | null
  repositoryUrl: string | null
  websiteUrl: string | null
}

export async function saveReport(db: D1Database, id: string, url: string, report: Report, opts: { list?: boolean; registry?: RegistryDetails } = {}): Promise<{ listed: boolean; blocked: boolean }> {
  await ensureSchema(db)
  const blob = await gzip(JSON.stringify({ ...report, url }))
  const now = new Date().toISOString()
  // Listing rules: never list a report made with someone's credentials (its tool list may be
  // private), never re-list a server its owner removed, and keep an existing listing on re-share.
  const row = await db
    .prepare(`INSERT INTO servers (id, url, name, version, grade, score, era, spec_version, tools_count, partial, auth_required, authenticated, report, checked_at, created_at, updated_at, last_attempt_at, listed, failures)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15, ?15, CASE WHEN ?16 = 1 AND ?12 = 0 THEN 1 ELSE 0 END, 0)
              ON CONFLICT (id) DO UPDATE SET name = ?3, version = ?4, grade = ?5, score = ?6, era = ?7, spec_version = ?8,
                tools_count = ?9, partial = ?10, auth_required = ?11, authenticated = ?12, report = ?13, checked_at = ?14, updated_at = ?15,
                last_attempt_at = ?15, failures = 0,
                listed = CASE WHEN servers.blocked = 1 OR ?12 = 1 THEN 0 WHEN ?16 = 1 THEN 1 ELSE servers.listed END
              RETURNING listed, blocked`)
    .bind(
      id, url,
      report.serverInfo?.title ?? report.serverInfo?.name ?? null,
      report.serverInfo?.version ?? null,
      report.grade, report.score, report.era ?? null, report.version ?? null,
      report.tools.length, report.partial ? 1 : 0, report.auth?.required ? 1 : 0, report.authenticated ? 1 : 0,
      blob, report.checkedAt, now, opts.list ? 1 : 0,
    )
    .first<{ listed: number; blocked: number }>()
  if (opts.registry) {
    await db
      .prepare(`UPDATE servers SET registry_name = ?2, description = ?3, repository_url = ?4, website_url = ?5 WHERE id = ?1`)
      .bind(id, opts.registry.registryName, opts.registry.description, opts.registry.repositoryUrl, opts.registry.websiteUrl)
      .run()
  }
  return { listed: !!row?.listed, blocked: !!row?.blocked }
}

// --- the directory --------------------------------------------------------------------------

export interface DirectoryEntry {
  id: string
  url: string
  name: string | null
  grade: string
  score: number
  tools_count: number
  spec_version: string | null
  era: string | null
  partial: number
  auth_required: number
  checked_at: string
  description: string | null
}

export const PAGE_SIZE = 30

export async function listServers(db: D1Database, q: { search?: string; grade?: string; sort?: 'grade' | 'recent'; page?: number }): Promise<{ servers: DirectoryEntry[]; total: number }> {
  await ensureSchema(db)
  const where = ['listed = 1', 'blocked = 0']
  const binds: unknown[] = []
  if (q.search) {
    // Escape LIKE wildcards so a search for "%" or "_" matches literally.
    const like = `%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    where.push(`(name LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`)
    binds.push(like, like, like)
  }
  if (q.grade) {
    where.push('grade = ?')
    binds.push(q.grade)
  }
  const order = q.sort === 'recent' ? 'checked_at DESC' : 'grade ASC, partial ASC, score DESC, name ASC'
  const page = Math.max(1, q.page ?? 1)
  const [rows, count] = await db.batch([
    db.prepare(`SELECT id, url, name, grade, score, tools_count, spec_version, era, partial, auth_required, checked_at, description FROM servers WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`).bind(...binds),
    db.prepare(`SELECT COUNT(*) AS n FROM servers WHERE ${where.join(' AND ')}`).bind(...binds),
  ])
  return { servers: (rows?.results ?? []) as DirectoryEntry[], total: Number((count?.results?.[0] as { n?: number } | undefined)?.n ?? 0) }
}

/** Every listed server, for the sitemap. */
export async function listedIds(db: D1Database): Promise<{ id: string; checked_at: string }[]> {
  await ensureSchema(db)
  const { results } = await db.prepare(`SELECT id, checked_at FROM servers WHERE listed = 1 AND blocked = 0 ORDER BY checked_at DESC LIMIT 45000`).all<{ id: string; checked_at: string }>()
  return results
}

/** Listed servers whose report is older than `olderThan`, least recently tried first. */
export async function dueForRecheck(db: D1Database, olderThan: string, retryAfter: string, limit: number): Promise<{ id: string; url: string }[]> {
  await ensureSchema(db)
  const { results } = await db
    .prepare(`SELECT id, url FROM servers WHERE listed = 1 AND blocked = 0 AND authenticated = 0 AND checked_at < ?1
              AND (last_attempt_at IS NULL OR last_attempt_at < ?2) ORDER BY COALESCE(last_attempt_at, checked_at) ASC LIMIT ?3`)
    .bind(olderThan, retryAfter, limit)
    .all<{ id: string; url: string }>()
  return results
}

/** A re-check couldn't reach the server. Three in a row removes it from the directory. */
export async function recordFailure(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(`UPDATE servers SET failures = failures + 1, last_attempt_at = ?2, listed = CASE WHEN failures + 1 >= 3 THEN 0 ELSE listed END WHERE id = ?1`)
    .bind(id, new Date().toISOString())
    .run()
}

/** The owner asked for removal: unlist, and never allow re-listing. */
export async function blockServer(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE servers SET listed = 0, blocked = 1, updated_at = ?2 WHERE id = ?1`).bind(id, new Date().toISOString()).run()
}

export async function serverUrl(db: D1Database, id: string): Promise<string | undefined> {
  await ensureSchema(db)
  return (await db.prepare(`SELECT url FROM servers WHERE id = ?`).bind(id).first<string>('url')) ?? undefined
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
  listed: number
  blocked: number
  registry_name: string | null
  description: string | null
  repository_url: string | null
  website_url: string | null
}

export async function loadReport(db: D1Database, id: string): Promise<{ meta: StoredServer; report: Report } | undefined> {
  await ensureSchema(db)
  const row = await db.prepare(`SELECT id, url, name, grade, score, partial, checked_at, last_viewed_at, listed, blocked, registry_name, description, repository_url, website_url, report FROM servers WHERE id = ?`).bind(id).first<StoredServer & { report: ArrayBuffer | number[] }>()
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
