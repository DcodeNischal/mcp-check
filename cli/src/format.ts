// The command line's pure parts: argument parsing, pass/fail thresholds, and the text and
// Markdown reports. No Node APIs here, so it can be tested anywhere.
import type { Category, CheckResult, Grade, Report, Status } from '../../src/checks/types'
import { checkTarget } from '../../src/security/target'

export const WEB = 'https://mcp.nischaldhakal.com.np'
const GRADES: Grade[] = ['A', 'B', 'C', 'D', 'F']

export interface CliOptions {
  url: string
  headers: Record<string, string>
  minGrade?: Grade
  minScore?: number
  format: 'text' | 'json' | 'markdown'
  verbose: boolean
  color: boolean
  timeoutMs?: number
}

export type Parsed = { kind: 'run'; options: CliOptions } | { kind: 'help' } | { kind: 'version' } | { kind: 'error'; message: string }

export const USAGE = `Usage: mcp-check <url> [options]

Grade an MCP server against the current spec: protocol, tools, auth, security and speed.

Options:
  -H, --header "Name: value"  Send a header with every request (repeatable)
  --token <token>             Send "Authorization: Bearer <token>" (or set MCP_CHECK_TOKEN)
  --min-grade <A-F>           Exit with code 1 if the grade is below this
  --min-score <0-100>         Exit with code 1 if the score is below this
  --json                      Print the full report as JSON
  --markdown                  Print a Markdown summary
  -v, --verbose               Also list the checks that passed
  --timeout <seconds>         Time limit per request (default 15)
  --no-color                  Plain output
  -h, --help                  Show this help
  --version                   Show the version

Exit codes: 0 passed, 1 below --min-grade or --min-score, 2 server unreachable or bad usage.
Servers on localhost and plain http are allowed here (they aren't on the website).

Examples:
  npx @dcodenischal/mcp-check https://mcp.example.com/mcp
  npx @dcodenischal/mcp-check http://localhost:3000/mcp --min-grade B
  MCP_CHECK_TOKEN=... npx @dcodenischal/mcp-check https://mcp.example.com/mcp --markdown`

export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): Parsed {
  const headers: Record<string, string> = {}
  let url: string | undefined
  let token = env.MCP_CHECK_TOKEN
  let minGrade: Grade | undefined
  let minScore: number | undefined
  let format: CliOptions['format'] = 'text'
  let verbose = false
  let color = !env.NO_COLOR
  let timeoutMs: number | undefined

  const args = argv.flatMap((a) => (/^--[a-z-]+=/.test(a) ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a]))
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const value = (): string | undefined => args[++i]
    switch (arg) {
      case '-h':
      case '--help':
        return { kind: 'help' }
      case '--version':
        return { kind: 'version' }
      case '-H':
      case '--header': {
        const h = value()
        const m = h?.match(/^([A-Za-z0-9-]+)\s*:\s*(.*)$/)
        if (!m) return { kind: 'error', message: `--header needs "Name: value", got ${JSON.stringify(h ?? '')}.` }
        headers[m[1]!] = m[2]!
        break
      }
      case '--token':
        token = value()
        if (!token) return { kind: 'error', message: '--token needs a value.' }
        break
      case '--min-grade': {
        const g = value()?.toUpperCase()
        if (!g || !GRADES.includes(g as Grade)) return { kind: 'error', message: '--min-grade must be one of A, B, C, D, F.' }
        minGrade = g as Grade
        break
      }
      case '--min-score': {
        const n = Number(value())
        if (!Number.isFinite(n) || n < 0 || n > 100) return { kind: 'error', message: '--min-score must be a number from 0 to 100.' }
        minScore = n
        break
      }
      case '--timeout': {
        const s = Number(value())
        if (!Number.isFinite(s) || s <= 0 || s > 300) return { kind: 'error', message: '--timeout must be a number of seconds from 1 to 300.' }
        timeoutMs = Math.round(s * 1000)
        break
      }
      case '--json':
        format = 'json'
        break
      case '--markdown':
        format = 'markdown'
        break
      case '-v':
      case '--verbose':
        verbose = true
        break
      case '--no-color':
        color = false
        break
      default:
        if (arg.startsWith('-')) return { kind: 'error', message: `Unknown option ${arg}. Run mcp-check --help.` }
        if (url) return { kind: 'error', message: 'Give one server URL.' }
        url = arg
    }
  }
  if (!url) return { kind: 'error', message: 'Give the server URL, like: mcp-check https://mcp.example.com/mcp' }
  if (token) headers.Authorization = `Bearer ${token}`
  return {
    kind: 'run',
    options: { url, headers, format, verbose, color, ...(minGrade ? { minGrade } : {}), ...(minScore !== undefined ? { minScore } : {}), ...(timeoutMs ? { timeoutMs } : {}) },
  }
}

export interface Verdict {
  /** 0 passed, 1 below the threshold, 2 couldn't check. */
  exitCode: 0 | 1 | 2
  message: string
}

export function verdict(report: Report, o: Pick<CliOptions, 'minGrade' | 'minScore'>): Verdict {
  if (!report.connected && !report.auth) return { exitCode: 2, message: `Couldn't check the server: ${report.error ?? 'it did not respond as an MCP server.'}` }
  const problems: string[] = []
  if (o.minGrade && GRADES.indexOf(report.grade) > GRADES.indexOf(o.minGrade)) problems.push(`grade ${report.grade} is below the minimum ${o.minGrade}`)
  if (o.minScore !== undefined && report.score < o.minScore) problems.push(`score ${report.score} is below the minimum ${o.minScore}`)
  if (problems.length) return { exitCode: 1, message: `Failed: ${problems.join(' and ')}.` }
  const threshold = [o.minGrade && `grade ${o.minGrade}`, o.minScore !== undefined && `score ${o.minScore}`].filter(Boolean).join(' and ')
  return { exitCode: 0, message: threshold ? `Passed: meets the minimum ${threshold}.` : 'Done.' }
}

// --- presentation ----------------------------------------------------------------------------

const CATEGORY_ORDER: Category[] = ['protocol', 'tools', 'auth', 'security', 'performance']
const CATEGORY_LABEL: Record<Category, string> = { protocol: 'Protocol', tools: 'Tools', auth: 'Authentication', security: 'Security', performance: 'Speed' }
const ERA_LABEL: Record<string, string> = { modern: 'stateless HTTP', 'legacy-streamable': 'Streamable HTTP', 'legacy-sse': 'HTTP+SSE (deprecated)' }
const SYMBOL: Record<Status, string> = { pass: '✓', warn: '!', fail: '✗', info: 'i', skip: '–' }
const EMOJI: Record<Status, string> = { pass: '✅', warn: '⚠️', fail: '❌', info: 'ℹ️', skip: '➖' }
const STATUS_ORDER: Record<Status, number> = { fail: 0, warn: 1, info: 2, pass: 3, skip: 4 }

/** A link to the same check on the website, for servers the website can reach. */
export function webLink(url: string): string | undefined {
  return checkTarget(url).ok ? `${WEB}/?url=${encodeURIComponent(url)}` : undefined
}

// Newlines too: in the GitHub Action, a line starting with :: would be read as a workflow command.
const safe = (s: string | undefined) => (s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')

function summaryLine(report: Report): string {
  const parts = [
    report.version && `spec ${report.version}${report.era ? ` (${ERA_LABEL[report.era] ?? report.era})` : ''}`,
    report.connected && !report.partial && `${report.tools.length} tool${report.tools.length === 1 ? '' : 's'}`,
    `checked in ${(report.durationMs / 1000).toFixed(1)}s`,
  ]
  return safe(parts.filter(Boolean).join(' · '))
}

function counts(checks: CheckResult[]) {
  const n = (s: Status) => checks.filter((c) => c.status === s).length
  return { pass: n('pass'), warn: n('warn'), fail: n('fail') }
}

const sorted = (checks: CheckResult[]) =>
  [...checks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category))

/** Strip control characters from server-supplied text, so it can't send escape codes to the terminal. */

export function renderText(report: Report, o: { color: boolean; verbose: boolean }, v?: Verdict): string {
  const paint = (code: string) => (s: string) => (o.color ? `\x1b[${code}m${s}\x1b[0m` : s)
  const bold = paint('1')
  const dim = paint('2')
  const tone: Record<Status, (s: string) => string> = { pass: paint('32'), warn: paint('33'), fail: paint('31'), info: paint('36'), skip: dim }
  const gradeTone = report.grade === 'A' || report.grade === 'B' ? tone.pass : report.grade === 'C' ? tone.warn : tone.fail

  const out: string[] = ['', `${bold('MCP Check')}  ${safe(report.url)}`, '']
  if (!report.connected && !report.auth) {
    out.push(`  ${tone.fail('✗')} ${safe(report.error) || 'The server did not respond as an MCP server.'}`, '')
    if (v) out.push(tone.fail(v.message), '')
    return out.join('\n')
  }
  out.push(`  ${gradeTone(bold(`Grade ${report.grade}`))}  ${bold(`${report.score}/100`)}  ${dim(summaryLine(report))}`)
  if (report.partial) out.push(`  ${tone.warn('Partial grade:')} the server requires sign-in. Pass --token to grade its tools.`)
  out.push('')

  for (const c of sorted(report.checks)) {
    if (!o.verbose && (c.status === 'pass' || c.status === 'skip' || c.status === 'info')) continue
    out.push(`  ${tone[c.status](SYMBOL[c.status])} ${bold(safe(c.title))} ${dim(`(${CATEGORY_LABEL[c.category]})`)}`)
    out.push(`    ${safe(c.detail)}`)
    if (c.fix && c.status !== 'pass') out.push(`    ${dim('Fix:')} ${safe(c.fix)}`)
  }
  const n = counts(report.checks)
  out.push('', `  ${tone.pass(`${n.pass} passed`)} · ${tone.warn(`${n.warn} warning${n.warn === 1 ? '' : 's'}`)} · ${tone.fail(`${n.fail} failed`)}${o.verbose ? '' : dim('  (-v lists passing checks)')}`)
  const link = webLink(report.url)
  if (link) out.push(`  ${dim('On the web:')} ${link}`)
  out.push('')
  if (v && v.message !== 'Done.') out.push(v.exitCode === 0 ? tone.pass(safe(v.message)) : tone.fail(safe(v.message)), '')
  return out.join('\n')
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')

export function renderMarkdown(report: Report, v?: Verdict): string {
  const out: string[] = []
  if (!report.connected && !report.auth) {
    out.push(`### ❌ MCP Check: couldn't reach the server`, '', `\`${report.url}\``, '', report.error ?? 'The server did not respond as an MCP server.')
    return out.join('\n') + '\n'
  }
  const mark = v ? (v.exitCode === 0 ? ' ✅' : ' ❌') : ''
  out.push(`### MCP Check: grade ${report.grade} (${report.score}/100)${mark}`, '', `\`${report.url}\` · ${summaryLine(report)}`, '')
  if (v && v.message !== 'Done.') out.push(`**${v.message}**`, '')
  if (report.partial) out.push('> Partial grade: the server requires sign-in, so its tools were not graded. Pass a token to grade them.', '')

  const issues = sorted(report.checks).filter((c) => c.status === 'fail' || c.status === 'warn')
  if (issues.length) {
    out.push('| | Check | What we found | How to fix |', '|---|---|---|---|')
    for (const c of issues) out.push(`| ${EMOJI[c.status]} | ${cell(c.title)} | ${cell(c.detail)} | ${cell(c.fix ?? '')} |`)
    out.push('')
  } else {
    out.push('No warnings or failures. 🎉', '')
  }
  const passed = sorted(report.checks).filter((c) => c.status === 'pass')
  if (passed.length) {
    out.push(`<details><summary>${passed.length} passed check${passed.length === 1 ? '' : 's'}</summary>`, '')
    for (const c of passed) out.push(`- ✅ **${c.title}**: ${c.detail.replace(/\r?\n/g, ' ')}`)
    out.push('', '</details>', '')
  }
  const link = webLink(report.url)
  out.push(`Checked with [MCP Check](${WEB})${link ? ` · [open this check on the web](${link})` : ''}.`)
  return out.join('\n') + '\n'
}
