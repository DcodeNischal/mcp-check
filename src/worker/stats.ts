// Directory-wide numbers for /api/stats: grades, spec versions, sign-in, tools, and the most
// common problems. Each server's warnings and failures are stored as JSON at save time (the
// `issues` column), so these are plain SQL over the servers table, with no reports to unpack.
import type { Report } from '../checks/types'
import { registryStats } from './registry'
import { ensureSchema } from './store'

/** A server's warnings and failures, compact: id, title, f(ail) or w(arn). */
export function issuesOf(report: Report): string {
  return JSON.stringify(report.checks.filter((c) => c.status === 'fail' || c.status === 'warn').map((c) => ({ id: c.id, t: c.title, s: c.status === 'fail' ? 'f' : 'w' })))
}

export interface DirectoryStats {
  ok: true
  updatedAt: string
  /** Servers listed in the directory. */
  listed: number
  /** Servers whose tools could be graded (no sign-in needed). Grades and issues cover these. */
  graded: number
  /** Listed servers that require sign-in, graded on reachability and auth only. */
  signInRequired: number
  grades: Record<'A' | 'B' | 'C' | 'D' | 'F', number>
  /** Spec versions spoken by the servers that could be inspected, most common first. */
  versions: { version: string; servers: number }[]
  tools: { average: number; max: number }
  /** The most common warnings and failures among graded servers. */
  issues: { id: string; title: string; servers: number; failing: number }[]
  registry: Record<string, number>
}

const LISTED = `listed = 1 AND blocked = 0`

export async function directoryStats(db: D1Database): Promise<DirectoryStats> {
  await ensureSchema(db)
  const [totals, grades, versions, issues] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS listed, SUM(partial = 0) AS graded, SUM(partial) AS sign_in,
                       AVG(CASE WHEN partial = 0 THEN tools_count END) AS avg_tools, MAX(tools_count) AS max_tools
                FROM servers WHERE ${LISTED}`),
    db.prepare(`SELECT grade, COUNT(*) AS n FROM servers WHERE ${LISTED} AND partial = 0 GROUP BY grade`),
    db.prepare(`SELECT spec_version AS version, COUNT(*) AS n FROM servers WHERE ${LISTED} AND spec_version IS NOT NULL GROUP BY spec_version ORDER BY n DESC`),
    db.prepare(`SELECT json_extract(i.value, '$.id') AS check_id, MAX(json_extract(i.value, '$.t')) AS title, COUNT(*) AS n,
                       SUM(json_extract(i.value, '$.s') = 'f') AS failing
                FROM servers s, json_each(s.issues) i
                WHERE s.listed = 1 AND s.blocked = 0 AND s.partial = 0 AND s.issues IS NOT NULL
                GROUP BY check_id ORDER BY n DESC LIMIT 8`),
  ])
  const t = (totals?.results?.[0] ?? {}) as { listed?: number; graded?: number; sign_in?: number; avg_tools?: number | null; max_tools?: number | null }
  const gradeCounts: DirectoryStats['grades'] = { A: 0, B: 0, C: 0, D: 0, F: 0 }
  for (const r of (grades?.results ?? []) as { grade: keyof DirectoryStats['grades']; n: number }[]) if (r.grade in gradeCounts) gradeCounts[r.grade] = r.n
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    listed: t.listed ?? 0,
    graded: t.graded ?? 0,
    signInRequired: t.sign_in ?? 0,
    grades: gradeCounts,
    versions: ((versions?.results ?? []) as { version: string; n: number }[]).map((r) => ({ version: r.version, servers: r.n })),
    tools: { average: Math.round((t.avg_tools ?? 0) * 10) / 10, max: t.max_tools ?? 0 },
    issues: ((issues?.results ?? []) as { check_id: string; title: string; n: number; failing: number }[]).map((r) => ({ id: r.check_id, title: r.title, servers: r.n, failing: r.failing })),
    registry: await registryStats(db),
  }
}
