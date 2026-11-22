// mcp-check: grade an MCP server from the command line. Runs the same checks as the website,
// from your machine, so it can also check servers on localhost.
import { runCheck } from '../../src/checks/run'
import { parseArgs, renderMarkdown, renderText, USAGE, verdict } from './format'

declare const __VERSION__: string

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2), process.env)
  if (parsed.kind === 'help') return print(USAGE, 0)
  if (parsed.kind === 'version') return print(__VERSION__, 0)
  if (parsed.kind === 'error') return print(`${parsed.message}\n\n${USAGE}`, 2, true)

  const o = parsed.options
  const color = o.color && !!process.stdout.isTTY
  if (o.format === 'text' && process.stderr.isTTY) process.stderr.write(`Checking ${o.url}…\n`)
  const report = await runCheck(o.url, {
    allowLocal: true,
    headers: o.headers,
    vantage: 'your machine',
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
  })
  const v = verdict(report, o)
  if (o.format === 'json') print(JSON.stringify({ ...report, verdict: v }, null, 2), 0)
  else if (o.format === 'markdown') print(renderMarkdown(report, v), 0)
  else print(renderText(report, { color, verbose: o.verbose }, v), 0)
  return v.exitCode
}

function print(text: string, code: number, toStderr = false): number {
  ;(toStderr ? process.stderr : process.stdout).write(text.endsWith('\n') ? text : `${text}\n`)
  return code
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    process.stderr.write(`mcp-check failed: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 2
  },
)
