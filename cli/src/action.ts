// The GitHub Action: runs the check, writes a job summary, sets outputs, and fails the step when
// the server is below the minimum grade or score. Inputs arrive as INPUT_<NAME> variables.
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCheck } from '../../src/checks/run'
import type { Grade } from '../../src/checks/types'
import { renderMarkdown, renderText, verdict } from './format'

const input = (name: string) => (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim()
const setOutput = (name: string, value: string) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}
const escapeData = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

async function run(): Promise<void> {
  const url = input('url')
  if (!url) throw new Error('The "url" input is required.')

  const headers: Record<string, string> = {}
  const token = input('token')
  if (token) {
    process.stdout.write(`::add-mask::${token}\n`)
    headers.Authorization = `Bearer ${token}`
  }
  for (const line of input('headers').split(/\r?\n/)) {
    if (!line.trim()) continue
    const m = line.match(/^\s*([A-Za-z0-9-]+)\s*:\s*(.*)$/)
    if (!m) throw new Error(`Each line of "headers" must be "Name: value", got ${JSON.stringify(line.trim())}.`)
    headers[m[1]!] = m[2]!
    if (m[2]) process.stdout.write(`::add-mask::${m[2]}\n`)
  }

  const minGrade = input('min-grade').toUpperCase()
  if (minGrade && !/^[ABCDF]$/.test(minGrade)) throw new Error('"min-grade" must be one of A, B, C, D, F.')
  const minScoreRaw = input('min-score')
  const minScore = minScoreRaw ? Number(minScoreRaw) : undefined
  if (minScore !== undefined && (!Number.isFinite(minScore) || minScore < 0 || minScore > 100)) throw new Error('"min-score" must be a number from 0 to 100.')
  const timeout = Number(input('timeout') || 15)

  const report = await runCheck(url, { allowLocal: true, headers, vantage: 'GitHub Actions', timeoutMs: Math.round(timeout * 1000) })
  const v = verdict(report, { ...(minGrade ? { minGrade: minGrade as Grade } : {}), ...(minScore !== undefined ? { minScore } : {}) })

  process.stdout.write(renderText(report, { color: true, verbose: false }, v) + '\n')
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(report, v))

  const reportPath = join(process.env.RUNNER_TEMP ?? '.', 'mcp-check-report.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  setOutput('grade', report.connected || report.auth ? report.grade : '')
  setOutput('score', report.connected || report.auth ? String(report.score) : '')
  setOutput('passed', String(v.exitCode === 0))
  setOutput('report', reportPath)

  for (const c of report.checks.filter((c) => c.status === 'fail')) {
    process.stdout.write(`::warning title=${escapeData(`MCP Check: ${c.title}`)}::${escapeData(c.fix ? `${c.detail} Fix: ${c.fix}` : c.detail)}\n`)
  }
  if (v.exitCode !== 0) {
    process.stdout.write(`::error title=MCP Check::${escapeData(v.message)}\n`)
    process.exitCode = 1
  }
}

run().catch((err) => {
  process.stdout.write(`::error title=MCP Check::${escapeData(err instanceof Error ? err.message : String(err))}\n`)
  process.exitCode = 1
})
