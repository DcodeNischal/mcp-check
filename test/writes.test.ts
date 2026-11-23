// The database code against a real SQLite (Node's built-in one) with the real schema and migrations,
// counting every row each operation changes, triggers and the search index included. The free plan
// allows 100,000 row writes a day, so writes that change nothing must cost nothing.
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Report } from '../src/checks/types'
import { checksLeftToday, countCheck, DAILY_CHECK_BUDGET } from '../src/worker/budget'
import { syncStep } from '../src/worker/registry'
import { saveReport, serverId } from '../src/worker/store'

/** Just enough of the D1 API over node:sqlite for the code under test. */
function d1(db: DatabaseSync): D1Database {
  type P = string | number | null | Uint8Array
  const norm = (v: unknown): P => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : (v as P))
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...p: unknown[]) => statement(sql, p),
    first: async (col?: string) => {
      const row = db.prepare(sql).get(...params.map(norm)) as Record<string, unknown> | undefined
      return row ? (col ? row[col] : row) : null
    },
    all: async () => ({ results: db.prepare(sql).all(...params.map(norm)), success: true, meta: {} }),
    run: async () => ({ success: true, results: [], meta: { changes: Number(db.prepare(sql).run(...params.map(norm)).changes) } }),
  })
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: ReturnType<typeof statement>[]) => {
      db.exec('BEGIN')
      try {
        const out = []
        for (const s of stmts) out.push(await s.all())
        db.exec('COMMIT')
        return out
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
  } as unknown as D1Database
}

const raw = new DatabaseSync(':memory:')
const DB = d1(raw)
const totalChanges = () => Number((raw.prepare('SELECT total_changes() AS n').get() as { n: number }).n)
async function rowsWritten(fn: () => Promise<unknown>): Promise<number> {
  const before = totalChanges()
  await fn()
  return totalChanges() - before
}
const searchHits = (term: string) => raw.prepare(`SELECT id FROM server_search WHERE server_search MATCH ?`).all(term).map((r) => (r as { id: string }).id)

const report = (over: Partial<Report> = {}): Report => ({
  url: 'https://mcp.example.com/mcp', checkedAt: '2026-11-23T00:00:00.000Z', durationMs: 100, connected: true, authenticated: false,
  era: 'modern', version: '2026-07-28', steps: [], prompts: [], resources: [], resourceTemplates: [],
  tools: [{ name: 'send_email', description: 'Send an email to someone.' }],
  checks: [{ id: 'protocol.era', category: 'protocol', title: 'Speaks the current spec', status: 'pass', weight: 3, detail: 'ok' }],
  score: 100, grade: 'A', gradingVersion: 2, ...over,
})
const registry = { registryName: 'com.example/mail', description: 'Sends mail.', repositoryUrl: null, websiteUrl: null }
const URL_ = 'https://mcp.example.com/mcp'
// The real id (derived from the URL), so the registry sync finds the same server.
let ID = ''

beforeAll(async () => {
  ID = await serverId(URL_)
  // First use creates the schema and runs every migration, as in production.
  await saveReport(DB, ID, URL_, report(), { list: true, registry })
})

describe('saving reports', () => {
  it('indexes a new server for search, with its registry details', () => {
    expect(searchHits('mail')).toEqual([ID])
    expect(searchHits('send_email')).toEqual([ID])
  })

  it('re-saving an unchanged server writes only its own row', async () => {
    const n = await rowsWritten(() => saveReport(DB, ID, URL_, report({ checkedAt: '2026-11-30T00:00:00.000Z' }), { list: true, registry }))
    expect(n).toBe(1)
  })

  it('a re-check without registry details keeps them', async () => {
    await saveReport(DB, ID, URL_, report())
    expect(raw.prepare(`SELECT registry_name, description FROM servers WHERE id = ?`).get(ID)).toEqual({ registry_name: 'com.example/mail', description: 'Sends mail.' })
  })

  it('rebuilds the search entry when indexed text changes', async () => {
    const n = await rowsWritten(() => saveReport(DB, ID, URL_, report({ tools: [{ name: 'list_calendars', description: 'List calendars.' }] })))
    expect(n).toBeGreaterThan(1)
    expect(searchHits('calendars')).toEqual([ID])
    expect(searchHits('send_email')).toEqual([])
  })
})

describe('registry sync', () => {
  const page = {
    servers: [{
      server: { name: 'com.example/mail', title: 'Mail', description: 'Sends mail.', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }] },
      _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } },
    }],
    metadata: {},
  }
  const serve = (body: unknown) => (async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

  it('writes nothing for entries that did not change', async () => {
    await syncStep(DB, serve(page))
    const n = await rowsWritten(() => syncStep(DB, serve(page)))
    // Only the sync's own bookkeeping (cursor cleared, finish time) is written.
    expect(n).toBeLessThanOrEqual(2)
  })

  it('updates entries that did change', async () => {
    const changed = structuredClone(page)
    changed.servers[0]!.server.description = 'Sends and reads mail.'
    await syncStep(DB, serve(changed))
    expect(raw.prepare(`SELECT description FROM registry WHERE url = 'https://mcp.example.com/mcp'`).get()).toEqual({ description: 'Sends and reads mail.' })
    expect(raw.prepare(`SELECT description FROM servers WHERE id = ?`).get(ID)).toEqual({ description: 'Sends and reads mail.' })
    expect(searchHits('reads')).toEqual([ID])
  })
})

describe('daily check budget', () => {
  it('counts checks and starts again each day', async () => {
    const today = new Date().toISOString().slice(0, 10)
    raw.prepare(`INSERT INTO settings (key, value) VALUES ('checks_day', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run('2020-01-01:1999')
    expect(await checksLeftToday(DB)).toBe(DAILY_CHECK_BUDGET)
    await countCheck(DB)
    await countCheck(DB)
    expect(raw.prepare(`SELECT value FROM settings WHERE key = 'checks_day'`).get()).toEqual({ value: `${today}:2` })
    expect(await checksLeftToday(DB)).toBe(DAILY_CHECK_BUDGET - 2)
    raw.prepare(`UPDATE settings SET value = ? WHERE key = 'checks_day'`).run(`${today}:${DAILY_CHECK_BUDGET + 5}`)
    expect(await checksLeftToday(DB)).toBe(0)
  })
})
