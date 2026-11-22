import type { CheckResult, Grade } from './types'

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
