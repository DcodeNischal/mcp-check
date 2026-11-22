import type { CheckResult, Grade, Report } from './types'

/**
 * Bumped whenever the grading rules change, so stored reports can be regraded (see regrade).
 * 2: a missing Origin check fails (weight 3), spec versions two or more revisions old fail, and
 *    serious security failures cap the grade at B.
 */
export const GRADING_VERSION = 2

const POINTS = { pass: 1, warn: 0.5, fail: 0 } as const

/** Weighted score out of 100. Info and skipped checks don't count either way. */
export function score(checks: CheckResult[]): number {
  let earned = 0
  let possible = 0
  for (const c of checks) {
    if (c.status === 'info' || c.status === 'skip') continue
    earned += POINTS[c.status] * c.weight
    possible += c.weight
  }
  return possible === 0 ? 0 : Math.round((earned / possible) * 100)
}

export function grade(value: number): Grade {
  if (value >= 90) return 'A'
  if (value >= 80) return 'B'
  if (value >= 70) return 'C'
  if (value >= 60) return 'D'
  return 'F'
}

/** Failing one of these caps the grade at B: an A means no serious security problem. */
const CAPPING = new Set(['security.https', 'security.error-leaks'])

/** Score and grade for a set of checks, with the reason when the grade was capped. */
export function gradeChecks(checks: CheckResult[]): { score: number; grade: Grade; gradeCap?: string } {
  const value = score(checks)
  const g = grade(value)
  const cap = checks.find((c) => CAPPING.has(c.id) && c.status === 'fail')
  return cap && g === 'A' ? { score: value, grade: 'B', gradeCap: cap.title } : { score: value, grade: g }
}

/** Spec revisions two or more behind the current one. */
export const OLD_SPEC_VERSIONS = new Set(['2025-06-18', '2025-03-26'])

/** Bring a report graded under earlier rules up to the current ones. */
export function regrade(report: Report): Report {
  if ((report.gradingVersion ?? 1) >= GRADING_VERSION) return report
  const checks = report.checks.map((c): CheckResult => {
    if (c.id === 'security.origin') return { ...c, weight: 3, status: c.status === 'warn' ? 'fail' : c.status }
    if (c.id === 'protocol.era' && c.status === 'warn' && report.version && OLD_SPEC_VERSIONS.has(report.version)) return { ...c, status: 'fail' }
    return c
  })
  const { gradeCap: _old, ...rest } = report
  const g = gradeChecks(checks)
  return { ...rest, checks, score: g.score, grade: g.grade, ...(g.gradeCap ? { gradeCap: g.gradeCap } : {}), gradingVersion: GRADING_VERSION }
}
