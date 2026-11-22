// Runs a full check against one server and returns the graded report. The same code runs in
// the Worker (online checks) and the CLI (local servers), so grades match everywhere.
import { McpClient, isObject } from '../mcp/client'
import { ERROR, LEGACY_VERSIONS, MODERN_VERSION, type Exchange } from '../mcp/types'
import { checkTarget, type TargetPolicy } from '../security/target'
import { discoverAuth } from './auth'
import { grade, score } from './grade'
import { toolChecks } from './tools'
import type { CheckResult, Report, Status, ToolSummary } from './types'

export interface CheckOptions extends TargetPolicy {
  fetch?: typeof fetch
  /** Credentials and custom headers for the server. Used for the check, never put in the report. */
  headers?: Record<string, string>
  timeoutMs?: number
  /** Where speed is measured from, shown in the report ("Cloudflare's network", "your machine"). */
  vantage?: string
  /** Filled with every HTTP exchange of the check, for the raw log. */
  logSink?: Exchange[]
}

const PROBE_TOOL = 'mcp_check_probe_nonexistent_tool'
const FOREIGN_ORIGIN = 'https://mcp-check.invalid'

export async function runCheck(rawUrl: string, opts: CheckOptions = {}): Promise<Report> {
  const started = Date.now()
  const vantage = opts.vantage ?? 'the checker'
  const target = checkTarget(rawUrl, opts)
  const authenticated = Object.keys(opts.headers ?? {}).some((h) => h.toLowerCase() === 'authorization')
  const base = { url: rawUrl, checkedAt: new Date(started).toISOString(), authenticated, steps: [], tools: [], prompts: [], resources: [], resourceTemplates: [] }
  if (!target.ok) {
    return { ...base, durationMs: 0, connected: false, checks: [], score: 0, grade: 'F', error: target.reason }
  }

  const url = target.url.toString()
  const guard = (u: string) => checkTarget(u, opts).ok
  const client = new McpClient(url, { ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.headers ? { headers: opts.headers } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) })
  const checks: CheckResult[] = [httpsCheck(target.url)]

  try {
    const conn = await client.connect()
    const report: Report = {
      ...base,
      url,
      durationMs: 0,
      connected: conn.ok,
      steps: conn.steps,
      checks,
      score: 0,
      grade: 'F',
      ...(conn.era ? { era: conn.era } : {}),
      ...(conn.version ? { version: conn.version } : {}),
      ...(conn.serverInfo ? { serverInfo: conn.serverInfo } : {}),
      ...(conn.capabilities ? { capabilities: conn.capabilities } : {}),
      ...(conn.instructions ? { instructions: conn.instructions } : {}),
    }

    // Protected server, checked without credentials: grade what's public (the auth setup).
    if (!conn.ok && conn.auth) {
      const auth = await discoverAuth(client.wire, url, conn.auth.wwwAuthenticate, guard)
      report.auth = auth.summary
      checks.push(...auth.checks)
      checks.push(info('tools.listed', 'tools', 'Tools listed', 'This server requires sign-in. Sign in to inspect and grade its tools.'))
      checks.push(...leakCheck(client.log), speedCheck('performance.connect', 'Connection speed', client.log[0], vantage))
      report.partial = true
      return finish(report, checks, started)
    }

    if (!conn.ok) {
      checks.push({ id: 'protocol.connect', category: 'protocol', title: 'Speaks MCP', status: 'fail', weight: 10, detail: conn.error ?? 'Could not connect.', fix: 'Check the URL points at the MCP endpoint (often /mcp) and that the server is running.' })
      report.error = conn.error ?? 'Could not connect.'
      return { ...finish(report, checks, started), score: 0, grade: 'F' }
    }

    checks.push(...protocolChecks(conn, client.log))
    // Time the exchange that actually connected, not the earlier attempts in other eras.
    const connected = conn.era === 'modern'
      ? client.log.find((e) => e.rpcMethod === 'server/discover' && e.status === 200)
      : client.log.find((e) => e.rpcMethod === 'initialize' && !e.error)
    checks.push(speedCheck('performance.connect', 'Connection speed', connected, vantage))

    // Lists: only what the server says it supports (or everything, if it declares nothing).
    const caps = conn.capabilities
    const declares = (key: string) => !caps || key in caps
    if (declares('tools')) {
      const tools = await client.listAll<Record<string, unknown>>('tools/list', 'tools')
      report.tools = tools.items.filter(isObject).map(summarizeTool)
      if (tools.error) {
        checks.push({ id: 'tools.listed', category: 'tools', title: 'Tools listed', status: 'fail', weight: 3, detail: `tools/list failed: ${tools.error}`, fix: 'Make tools/list return { tools: [...] }.' })
      } else {
        checks.push({ id: 'tools.listed', category: 'tools', title: 'Tools listed', status: report.tools.length ? 'pass' : 'warn', weight: 3, detail: report.tools.length ? `${report.tools.length} tool${report.tools.length === 1 ? '' : 's'} across ${tools.pages} page${tools.pages === 1 ? '' : 's'}${tools.truncated ? ' (stopped at the limit)' : ''}.` : 'The server declares tools but lists none.' })
        if (report.tools.length) checks.push(...toolChecks(report.tools))
      }
      const listExchange = client.log.find((e) => e.rpcMethod === 'tools/list' && e.status === 200)
      if (listExchange) checks.push(speedCheck('performance.list', 'tools/list speed', listExchange, vantage))
    } else {
      checks.push(info('tools.listed', 'tools', 'Tools listed', 'The server does not declare the tools capability.'))
    }
    if (declares('prompts')) {
      const prompts = await client.listAll<Record<string, unknown>>('prompts/list', 'prompts')
      report.prompts = prompts.items.filter(isObject).map((p) => pick(p, ['name', 'title', 'description']) as Report['prompts'][number])
    }
    if (declares('resources')) {
      const resources = await client.listAll<Record<string, unknown>>('resources/list', 'resources')
      report.resources = resources.items.filter(isObject).map((r) => pick(r, ['uri', 'name', 'description', 'mimeType']) as Report['resources'][number])
      const templates = await client.listAll<Record<string, unknown>>('resources/templates/list', 'resourceTemplates')
      report.resourceTemplates = templates.items.filter(isObject).map((r) => pick(r, ['uriTemplate', 'name', 'description']) as Report['resourceTemplates'][number])
    }

    checks.push(...(await probeChecks(client)))
    checks.push(...leakCheck(client.log))
    checks.push(info('auth.public', 'auth', 'Sign-in', authenticated ? 'Checked with the credentials you provided.' : 'No sign-in required: anyone with the URL can use this server.'))
    return finish(report, checks, started)
  } finally {
    await client.close().catch(() => {})
    opts.logSink?.push(...client.log)
  }
}

function finish(report: Report, checks: CheckResult[], started: number): Report {
  const value = score(checks)
  return { ...report, checks, score: value, grade: grade(value), durationMs: Date.now() - started }
}

// --- protocol ------------------------------------------------------------------------------

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

function httpsCheck(url: URL): CheckResult {
  // A server on this machine (the command line, in CI) isn't expected to have a certificate.
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) {
    return { id: 'security.https', category: 'security', title: 'Served over HTTPS', status: 'info', weight: 0, detail: 'Not checked: the server is on this machine. Serve it over HTTPS when you deploy it.' }
  }
  return url.protocol === 'https:'
    ? { id: 'security.https', category: 'security', title: 'Served over HTTPS', status: 'pass', weight: 3, detail: 'The endpoint uses HTTPS.' }
    : { id: 'security.https', category: 'security', title: 'Served over HTTPS', status: 'fail', weight: 3, detail: 'The endpoint uses plain HTTP, so tokens and tool data travel unencrypted.', fix: 'Serve the MCP endpoint over HTTPS.' }
}

function protocolChecks(conn: Awaited<ReturnType<McpClient['connect']>>, log: Exchange[]): CheckResult[] {
  const out: CheckResult[] = []
  const era = conn.era!
  if (era === 'modern') {
    out.push({ id: 'protocol.era', category: 'protocol', title: 'Speaks the current spec', status: 'pass', weight: 3, detail: `Speaks ${MODERN_VERSION}, the current MCP revision.` })
  } else if (era === 'legacy-streamable') {
    const latestLegacy = conn.version === LEGACY_VERSIONS[0]
    out.push({
      id: 'protocol.era', category: 'protocol', title: 'Speaks the current spec', status: 'warn', weight: 3,
      detail: `Speaks ${conn.version} over Streamable HTTP. ${latestLegacy ? 'That was the previous revision' : 'That is an older revision'}; current clients expect ${MODERN_VERSION} (stateless, no initialize handshake).`,
      fix: `Upgrade your MCP SDK to one that supports ${MODERN_VERSION}, keeping ${LEGACY_VERSIONS[0]} for older clients.`,
    })
  } else {
    out.push({
      id: 'protocol.era', category: 'protocol', title: 'Speaks the current spec', status: 'fail', weight: 3,
      detail: `Uses the deprecated HTTP+SSE transport (${conn.version}). Many current clients can't connect to it.`,
      fix: 'Move to Streamable HTTP and the current spec revision.',
    })
  }

  const info_ = conn.serverInfo
  out.push(info_?.name && info_.version
    ? { id: 'protocol.server-info', category: 'protocol', title: 'Identifies itself', status: 'pass', weight: 2, detail: `${info_.name} ${info_.version}.` }
    : { id: 'protocol.server-info', category: 'protocol', title: 'Identifies itself', status: 'warn', weight: 2, detail: info_?.name ? `Gives a name (${info_.name}) but no version.` : 'Sends no serverInfo.', fix: era === 'modern' ? 'Include _meta["io.modelcontextprotocol/serverInfo"] with name and version in server/discover.' : 'Include serverInfo { name, version } in the initialize result.' })

  const known = [MODERN_VERSION, ...LEGACY_VERSIONS, '2024-11-05']
  out.push(conn.version && known.includes(conn.version)
    ? { id: 'protocol.version', category: 'protocol', title: 'Negotiates a real version', status: 'pass', weight: 2, detail: `Agreed on ${conn.version}.` }
    : { id: 'protocol.version', category: 'protocol', title: 'Negotiates a real version', status: 'fail', weight: 2, detail: `Answered with "${conn.version}", which isn't a published revision.`, fix: 'Return one of the published protocol versions.' })

  const posts = log.filter((e) => e.method === 'POST' && e.status !== undefined && e.status >= 200 && e.status < 300 && e.status !== 202)
  const wrong = posts.filter((e) => !/application\/json|text\/event-stream/i.test(e.contentType ?? ''))
  out.push(wrong.length
    ? { id: 'protocol.content-type', category: 'protocol', title: 'Correct response content types', status: 'fail', weight: 1, detail: `${wrong.length} response${wrong.length === 1 ? '' : 's'} used ${wrong[0]?.contentType ?? 'no content type'}.`, fix: 'Respond with application/json or text/event-stream.' }
    : { id: 'protocol.content-type', category: 'protocol', title: 'Correct response content types', status: 'pass', weight: 1, detail: 'Responses use application/json or text/event-stream.' })

  if (era === 'legacy-streamable') {
    const s = conn.initializedStatus
    out.push(s === 202
      ? { id: 'protocol.notifications', category: 'protocol', title: 'Accepts notifications', status: 'pass', weight: 1, detail: 'notifications/initialized was accepted with 202.' }
      : { id: 'protocol.notifications', category: 'protocol', title: 'Accepts notifications', status: s !== undefined && s >= 200 && s < 300 ? 'warn' : 'fail', weight: 1, detail: `notifications/initialized got HTTP ${s ?? 'no response'} (expected 202).`, fix: 'Answer notifications with 202 Accepted and no body.' })
  }
  if (era === 'modern') {
    const results = log.flatMap((e) => e.messages).filter((m): m is { result: Record<string, unknown> } => isObject(m) && isObject((m as Record<string, unknown>).result))
    const missing = results.filter((m) => typeof m.result.resultType !== 'string')
    out.push(missing.length
      ? { id: 'protocol.result-type', category: 'protocol', title: 'Results declare resultType', status: 'warn', weight: 1, detail: `${missing.length} result${missing.length === 1 ? '' : 's'} had no resultType.`, fix: 'Add resultType: "complete" to every result (required in 2026-07-28).' }
      : { id: 'protocol.result-type', category: 'protocol', title: 'Results declare resultType', status: 'pass', weight: 1, detail: 'Every result declares resultType.' })
  }
  return out
}

// --- probes: how the server handles mistakes -------------------------------------------

async function probeChecks(client: McpClient): Promise<CheckResult[]> {
  const out: CheckResult[] = []

  const unknown = await client.request('mcp-check/unknown-method')
  if (unknown.error?.code === ERROR.methodNotFound) {
    out.push({ id: 'protocol.unknown-method', category: 'protocol', title: 'Rejects unknown methods properly', status: 'pass', weight: 2, detail: 'An unknown method gets JSON-RPC error -32601.' })
  } else if (unknown.error) {
    out.push({ id: 'protocol.unknown-method', category: 'protocol', title: 'Rejects unknown methods properly', status: 'warn', weight: 2, detail: `An unknown method gets error ${unknown.error.code} instead of -32601.`, fix: 'Return -32601 (Method not found) for methods you don\'t implement.' })
  } else {
    out.push({ id: 'protocol.unknown-method', category: 'protocol', title: 'Rejects unknown methods properly', status: 'fail', weight: 2, detail: unknown.result ? 'An unknown method returned a result instead of an error.' : `An unknown method got ${describeExchange(unknown.exchange)} instead of a JSON-RPC error.`, fix: 'Return a JSON-RPC error -32601 (Method not found).' })
  }

  const call = await client.callTool(PROBE_TOOL, {})
  const isErrorResult = call.result?.isError === true
  if (call.error?.code === ERROR.invalidParams || isErrorResult) {
    out.push({ id: 'tools.unknown-tool', category: 'tools', title: 'Handles calls to unknown tools', status: 'pass', weight: 1, detail: call.error ? 'Calling a tool that doesn\'t exist returns error -32602.' : 'Calling a tool that doesn\'t exist returns an isError result.' })
  } else if (call.error) {
    out.push({ id: 'tools.unknown-tool', category: 'tools', title: 'Handles calls to unknown tools', status: 'warn', weight: 1, detail: `Calling a tool that doesn't exist returns error ${call.error.code} (the spec uses -32602).`, fix: 'Return -32602 for unknown tool names.' })
  } else {
    out.push({ id: 'tools.unknown-tool', category: 'tools', title: 'Handles calls to unknown tools', status: 'fail', weight: 1, detail: call.result ? 'Calling a tool that doesn\'t exist "succeeded".' : `Calling a tool that doesn't exist got ${describeExchange(call.exchange)}.`, fix: 'Return a JSON-RPC error -32602 for unknown tool names.' })
  }

  // Servers MUST reject requests from foreign web origins (protects against DNS rebinding).
  if (client.era !== 'legacy-sse') {
    const method = client.era === 'modern' ? 'server/discover' : 'tools/list'
    const foreign = await client.request(method, {}, undefined, { Origin: FOREIGN_ORIGIN })
    const s = foreign.exchange.status
    out.push(s === 403
      ? { id: 'security.origin', category: 'security', title: 'Rejects requests from other websites', status: 'pass', weight: 1, detail: 'A request with a foreign Origin header was refused with 403.' }
      : { id: 'security.origin', category: 'security', title: 'Rejects requests from other websites', status: s !== undefined && s >= 400 ? 'pass' : 'warn', weight: 1, detail: s !== undefined && s >= 400 ? `A request with a foreign Origin header was refused (HTTP ${s}).` : 'A request with a foreign Origin header was accepted. Browsers on any website could send requests to this server.', ...(s !== undefined && s < 400 ? { fix: 'Validate the Origin header and return 403 when it isn\'t an origin you trust.' } : {}) })
  }
  return out
}

// --- security & speed ------------------------------------------------------------------

const LEAK_PATTERNS: [RegExp, string][] = [
  [/\n\s+at\s+\S.*\(.*:\d+:\d+\)/, 'a JavaScript stack trace'],
  [/Traceback \(most recent call last\)/, 'a Python traceback'],
  [/node:internal\//, 'Node.js internals'],
  [/(?:^|[\s"'(])(?:\/home|\/usr|\/var|\/srv|\/opt|\/app)\/[\w./-]+\.(?:js|ts|py|go|rb|java|php)\b/, 'a server file path'],
  [/[A-Z]:\\(?:Users|inetpub|Program Files)\\/i, 'a Windows file path'],
  [/\bat [\w$.]+\.java:\d+\)|Exception in thread/, 'a Java stack trace'],
  [/goroutine \d+ \[running\]/, 'a Go panic trace'],
]

function leakCheck(log: Exchange[]): CheckResult[] {
  const texts: string[] = []
  for (const e of log) {
    if (e.rawText && (e.status ?? 0) >= 400) texts.push(e.rawText)
    for (const m of e.messages) {
      const err = isObject(m) && isObject((m as Record<string, unknown>).error) ? ((m as Record<string, unknown>).error as Record<string, unknown>) : undefined
      if (err) texts.push(`${String(err.message ?? '')}\n${typeof err.data === 'string' ? err.data : JSON.stringify(err.data ?? '')}`)
    }
  }
  const hits = new Set<string>()
  for (const t of texts) for (const [re, label] of LEAK_PATTERNS) if (re.test(t)) hits.add(label)
  if (!texts.length) return [info('security.error-leaks', 'security', 'Errors don\'t leak internals', 'No error responses to inspect.')]
  return [hits.size
    ? { id: 'security.error-leaks', category: 'security', title: 'Errors don\'t leak internals', status: 'fail', weight: 2, detail: `Error responses expose ${[...hits].join(', ')}.`, fix: 'Return short error messages to clients and log the details on the server.' }
    : { id: 'security.error-leaks', category: 'security', title: 'Errors don\'t leak internals', status: 'pass', weight: 2, detail: `${texts.length} error response${texts.length === 1 ? '' : 's'} checked; none expose stack traces or file paths.` }]
}

function speedCheck(id: string, title: string, exchange: Exchange | undefined, vantage: string): CheckResult {
  if (!exchange || exchange.status === undefined) return info(id, 'performance', title, 'Not measured.')
  const ms = exchange.ms
  const status: Status = ms < 1000 ? 'pass' : ms < 3000 ? 'warn' : 'fail'
  return { id, category: 'performance', title, status, weight: id === 'performance.connect' ? 2 : 1, detail: `${ms} ms, measured from ${vantage}.`, ...(status !== 'pass' ? { fix: 'Responses over a second slow down every agent turn that uses this server.' } : {}) }
}

// --- helpers ---------------------------------------------------------------------------

function info(id: string, category: CheckResult['category'], title: string, detail: string): CheckResult {
  return { id, category, title, status: 'info', weight: 0, detail }
}

function describeExchange(e: Exchange): string {
  if (e.error) return e.error
  if (e.status === undefined) return 'no response'
  return `HTTP ${e.status}${e.rawText ? ' with a non-JSON body' : ''}`
}

function summarizeTool(t: Record<string, unknown>): ToolSummary {
  // Untrusted input: keep only known fields, and make sure the name is a string.
  const tool = pick(t, ['title', 'description', 'inputSchema', 'outputSchema', 'annotations']) as Omit<ToolSummary, 'name'>
  return { name: typeof t.name === 'string' ? t.name : String(t.name ?? ''), ...tool }
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k]
  return out
}
