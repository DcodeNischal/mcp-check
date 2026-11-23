// MCP Check's own MCP server, at /mcp: check, search and look up MCP servers from inside an agent.
// It speaks the current revision (2026-07-28, stateless) and Streamable HTTP for older clients
// (2025-03-26 to 2025-11-25) without sessions, and is built to pass every check MCP Check runs.
import { runCheck } from '../checks/run'
import type { Report } from '../checks/types'
import { LEGACY_VERSIONS, MODERN_VERSION } from '../mcp/types'
import { searchServers, type SearchEnv } from './search'
import { rateKey, targetKey } from './ratelimit'
import { storedStats } from './stats'
import { canonicalUrl, loadReport, serverId } from './store'

export const OWN_ORIGIN = 'https://mcp.nischaldhakal.com.np'
export const OWN_MCP_URL = `${OWN_ORIGIN}/mcp`
/** The ownership proof MCP Check serves for its own server at /.well-known/mcp-check.txt. */
export async function ownProofText(): Promise<string> {
  return `# MCP Check owns its own MCP server at ${OWN_MCP_URL}
mcp-check: verify ${await serverId(OWN_MCP_URL)}
`
}

const SERVER_INFO = { name: 'mcp-check', title: 'MCP Check', version: '1.0.0', websiteUrl: OWN_ORIGIN }
const INSTRUCTIONS =
  'MCP Check grades MCP servers against the spec. Use check_server to grade any public server by URL, ' +
  'search_servers to find graded servers in the public directory, get_server for a directory server\'s latest report, ' +
  'and directory_stats for numbers across the whole directory.'

type Json = Record<string, unknown>

export interface McpServerEnv extends SearchEnv {
  CHECK_LIMITER: RateLimit
}

export interface McpContext {
  env: McpServerEnv
  /** The visitor's IP, for the rate limit on checks. */
  ip?: string
  /** A fetch that can reach this Worker's own hostname (for checking ourselves). */
  fetch?: typeof fetch
}

// --- tools -----------------------------------------------------------------------------------

const GRADES = ['A', 'B', 'C', 'D', 'F']
const summaryProperties = {
  url: { type: 'string', description: 'The server URL that was checked.' },
  grade: { type: 'string', enum: GRADES, description: 'The grade, A (best) to F.' },
  score: { type: 'integer', minimum: 0, maximum: 100, description: 'The score out of 100.' },
  specVersion: { type: ['string', 'null'], description: 'The MCP revision the server speaks, if it could be read.' },
  partial: { type: 'boolean', description: 'True when the server needs sign-in, so its tools were not graded.' },
  problems: {
    type: 'array',
    description: 'Warnings and failures, most serious first.',
    items: {
      type: 'object',
      properties: {
        check: { type: 'string', description: 'What was checked.' },
        status: { type: 'string', enum: ['fail', 'warn'], description: 'Whether the check failed or only warned.' },
        detail: { type: 'string', description: 'What MCP Check found.' },
        fix: { type: ['string', 'null'], description: 'How to fix it.' },
      },
      required: ['check', 'status', 'detail', 'fix'],
      additionalProperties: false,
    },
  },
  pageUrl: { type: 'string', description: 'A link to see this on the MCP Check website.' },
} as const

export const TOOLS = [
  {
    name: 'check_server',
    title: 'Check an MCP server',
    description:
      'Grade a public MCP server against the current MCP spec: protocol, tools, OAuth discovery, security and speed. ' +
      'Returns the grade (A to F), the score, and every warning or failure with how to fix it. Takes 5 to 20 seconds. ' +
      'Only public https URLs can be checked.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', format: 'uri', description: 'The MCP server endpoint, for example https://mcp.example.com/mcp.' } },
      required: ['url'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object', properties: summaryProperties, required: ['url', 'grade', 'score', 'specVersion', 'partial', 'problems', 'pageUrl'], additionalProperties: false },
    annotations: { title: 'Check an MCP server', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'search_servers',
    title: 'Search graded MCP servers',
    description:
      'Search the MCP Check directory, which grades every public server in the official MCP Registry. ' +
      'Matches names, descriptions, tools and meaning, so "send email" also finds email servers. Best matches first.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 100, description: 'What the server should do, or its name.' },
        grade: { type: 'string', enum: GRADES, description: 'Only return servers with this grade.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 10, description: 'How many results to return (1 to 20).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          description: 'Matching servers, best match first.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'The directory id, for get_server.' },
              name: { type: ['string', 'null'], description: 'The server name.' },
              url: { type: 'string', description: 'The server endpoint.' },
              grade: { type: 'string', enum: GRADES, description: 'Its grade.' },
              score: { type: 'integer', description: 'Its score out of 100.' },
              description: { type: ['string', 'null'], description: 'What it does, from the MCP Registry.' },
              match: { type: ['string', 'null'], description: 'Why it matched, when not obvious.' },
              pageUrl: { type: 'string', description: 'Its page on MCP Check.' },
            },
            required: ['id', 'name', 'url', 'grade', 'score', 'description', 'match', 'pageUrl'],
            additionalProperties: false,
          },
        },
        total: { type: 'integer', description: 'How many servers matched in all.' },
      },
      required: ['results', 'total'],
      additionalProperties: false,
    },
    annotations: { title: 'Search graded MCP servers', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_server',
    title: 'Get a directory server\'s report',
    description: 'Get the latest MCP Check report for a server in the directory: its grade, spec version and every warning or failure with a fix.',
    inputSchema: {
      type: 'object',
      properties: { server: { type: 'string', minLength: 1, maxLength: 2048, description: 'The server URL, or its MCP Check directory id (from search_servers).' } },
      required: ['server'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { ...summaryProperties, checkedAt: { type: 'string', description: 'When the server was last checked (ISO 8601).' } },
      required: ['url', 'grade', 'score', 'specVersion', 'partial', 'problems', 'pageUrl', 'checkedAt'],
      additionalProperties: false,
    },
    annotations: { title: 'Get a directory server\'s report', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'directory_stats',
    title: 'Directory statistics',
    description: 'Numbers across every server in the MCP Check directory: grades, spec versions, how many need sign-in, and the checks servers most often miss.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: {
        listed: { type: 'integer', description: 'Servers in the directory.' },
        graded: { type: 'integer', description: 'Servers whose tools could be graded.' },
        signInRequired: { type: 'integer', description: 'Servers that need sign-in.' },
        grades: { type: 'object', description: 'How many graded servers have each grade.', additionalProperties: { type: 'integer' } },
        versions: { type: 'array', description: 'Spec versions spoken, most common first.', items: { type: 'object', additionalProperties: true } },
        mostMissed: { type: 'array', description: 'The checks servers most often miss.', items: { type: 'object', additionalProperties: true } },
        updatedAt: { type: 'string', description: 'When these numbers were computed.' },
      },
      required: ['listed', 'graded', 'signInRequired', 'grades', 'versions', 'mostMissed', 'updatedAt'],
      additionalProperties: false,
    },
    annotations: { title: 'Directory statistics', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
] as const

class ToolError extends Error {}

function summarize(report: Report, pageUrl: string) {
  const order = { fail: 0, warn: 1 } as const
  const problems = report.checks
    .filter((c): c is typeof c & { status: 'fail' | 'warn' } => c.status === 'fail' || c.status === 'warn')
    .sort((a, b) => order[a.status] - order[b.status] || b.weight - a.weight)
    .map((c) => ({ check: c.title, status: c.status, detail: c.detail, fix: c.fix ?? null }))
  return { url: report.url, grade: report.grade, score: report.score, specVersion: report.version ?? null, partial: !!report.partial, problems, pageUrl }
}

function summaryText(s: ReturnType<typeof summarize>): string {
  const lines = [`${s.url}: grade ${s.grade} (${s.score}/100)${s.specVersion ? `, speaks ${s.specVersion}` : ''}${s.partial ? '. Needs sign-in, so its tools were not graded' : ''}.`]
  if (!s.problems.length) lines.push('No warnings or failures.')
  for (const p of s.problems) lines.push(`- ${p.status === 'fail' ? 'FAIL' : 'WARN'} ${p.check}: ${p.detail}${p.fix ? ` Fix: ${p.fix}` : ''}`)
  lines.push(`Details: ${s.pageUrl}`)
  return lines.join('\n')
}

async function callTool(name: string, args: Json, ctx: McpContext): Promise<{ text: string; structured: Json }> {
  const { env } = ctx
  switch (name) {
    case 'check_server': {
      const url = typeof args.url === 'string' ? args.url.trim() : ''
      if (!url) throw new ToolError('Give the server URL, for example https://mcp.example.com/mcp.')
      const { success } = await env.CHECK_LIMITER.limit({ key: rateKey(ctx.ip) })
      if (!success) throw new ToolError('Too many checks from your network. Try again in a minute.')
      const target = await env.CHECK_LIMITER.limit({ key: targetKey(url) })
      if (!target.success) throw new ToolError('That server is being checked a lot right now. Try again in a minute.')
      const report = await runCheck(url, { vantage: "Cloudflare's network", ...(ctx.fetch ? { fetch: ctx.fetch } : {}) })
      if (!report.connected && !report.auth) throw new ToolError(`Couldn't check ${url}: ${report.error ?? 'it did not respond as an MCP server.'}`)
      const s = summarize(report, `${OWN_ORIGIN}/?url=${encodeURIComponent(url)}`)
      return { text: summaryText(s), structured: s }
    }
    case 'search_servers': {
      const query = typeof args.query === 'string' ? args.query.trim().slice(0, 100) : ''
      if (query.length < 2) throw new ToolError('Give a search query of at least two characters.')
      const limited = await env.CHECK_LIMITER.limit({ key: `search:${rateKey(ctx.ip)}` })
      if (!limited.success) throw new ToolError('Too many searches. Try again in a minute.')
      const grade = typeof args.grade === 'string' && GRADES.includes(args.grade) ? args.grade : undefined
      const limit = Math.min(20, Math.max(1, Number.isInteger(args.limit) ? (args.limit as number) : 10))
      const found = await searchServers(env, { search: query, sort: 'relevance', page: 1, pageSize: limit, ...(grade ? { grade } : {}) })
      const results = found.servers.map((s) => ({
        id: s.id, name: s.name, url: s.url, grade: s.grade, score: s.score, description: s.description, match: s.match ?? null, pageUrl: `${OWN_ORIGIN}/r/${s.id}`,
      }))
      const text = results.length
        ? results.map((r) => `- ${r.name ?? r.url} (grade ${r.grade}, ${r.score}/100): ${r.url}${r.description ? ` — ${r.description}` : ''}${r.match ? ` [${r.match}]` : ''} · id ${r.id}`).join('\n')
        : `No servers in the directory match "${query}".`
      return { text, structured: { results, total: found.total } }
    }
    case 'get_server': {
      const server = typeof args.server === 'string' ? args.server.trim() : ''
      let id = /^[a-z2-9]{12}$/.test(server) ? server : ''
      if (!id) {
        const canonical = canonicalUrl(server)
        if (!canonical.ok) throw new ToolError('Give a server URL or a directory id from search_servers.')
        id = await serverId(canonical.url)
      }
      const found = await loadReport(env.DB, id)
      if (!found || !found.meta.listed || found.meta.blocked) {
        throw new ToolError('That server is not in the directory. Use check_server to grade it now.')
      }
      const s = { ...summarize(found.report, `${OWN_ORIGIN}/r/${id}`), checkedAt: found.report.checkedAt }
      return { text: `${summaryText(s)}\nLast checked ${s.checkedAt}.`, structured: s }
    }
    case 'directory_stats': {
      const st = await storedStats(env.DB)
      const mostMissed = st.issues.map((i) => ({ check: i.title, servers: i.servers, share: Math.round((i.servers / Math.max(1, st.issuesBase)) * 100) / 100 }))
      const structured = { listed: st.listed, graded: st.graded, signInRequired: st.signInRequired, grades: st.grades, versions: st.versions, mostMissed, updatedAt: st.updatedAt }
      const text = [
        `${st.listed} servers listed; ${st.graded} fully graded, ${st.signInRequired} need sign-in.`,
        `Grades: ${Object.entries(st.grades).map(([g, n]) => `${g} ${n}`).join(', ')}.`,
        `Spec versions: ${st.versions.map((v) => `${v.version} ${v.servers}`).join(', ')}.`,
        `Most missed: ${mostMissed.map((m) => `${m.check} (${Math.round(m.share * 100)}%)`).join(', ')}.`,
      ].join('\n')
      return { text, structured }
    }
    default:
      throw new UnknownTool(name)
  }
}

class UnknownTool extends Error {}

// --- protocol --------------------------------------------------------------------------------

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const rpcError = (id: unknown, code: number, message: string, status = 200, data?: unknown) =>
  json({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } }, status)

/** Browsers on other sites must not reach the server (the spec says servers MUST check Origin). */
export function allowedOrigin(origin: string | null): boolean {
  return !origin || origin === OWN_ORIGIN
}

export async function handleMcp(request: Request, ctx: McpContext): Promise<Response> {
  if (!allowedOrigin(request.headers.get('Origin'))) return new Response('Forbidden origin', { status: 403 })
  // Stateless: no server-to-client stream and no sessions to end.
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })

  let msg: Json
  try {
    const parsed = (await request.json()) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return rpcError(null, -32600, 'Send one JSON-RPC message per request.', 400)
    msg = parsed as Json
  } catch {
    return rpcError(null, -32700, 'Parse error', 400)
  }
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return msg.id === undefined ? new Response(null, { status: 202 }) : rpcError(msg.id, -32600, 'Invalid request')
  }
  // Notifications (no id) are accepted and need no answer.
  if (msg.id === undefined) return new Response(null, { status: 202 })

  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Json
  const meta = (params._meta && typeof params._meta === 'object' ? params._meta : {}) as Json
  const requested = meta['io.modelcontextprotocol/protocolVersion']
  const modern = requested !== undefined

  if (modern) {
    if (requested !== MODERN_VERSION) {
      return rpcError(msg.id, -32022, 'Unsupported protocol version', 400, { supported: [MODERN_VERSION, ...LEGACY_VERSIONS], requested })
    }
    if (request.headers.get('Mcp-Method') !== msg.method) return rpcError(msg.id, -32020, 'Mcp-Method header does not match the method', 400)
  }
  const reply = (result: Json) => json({ jsonrpc: '2.0', id: msg.id, result: modern ? { resultType: 'complete', ...result } : result })

  switch (msg.method) {
    case 'server/discover':
      return reply({
        supportedVersions: [MODERN_VERSION, ...LEGACY_VERSIONS],
        capabilities: { tools: { listChanged: false } },
        instructions: INSTRUCTIONS,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      })
    case 'initialize': {
      const asked = params.protocolVersion
      const version = (LEGACY_VERSIONS as readonly unknown[]).includes(asked) ? asked : LEGACY_VERSIONS[0]
      return reply({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS })
    }
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      if (!TOOLS.some((t) => t.name === name)) return rpcError(msg.id, -32602, `Unknown tool: ${name}`)
      const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Json
      try {
        const { text, structured } = await callTool(name, args, ctx)
        return reply({ content: [{ type: 'text', text }], structuredContent: structured, isError: false })
      } catch (err) {
        if (err instanceof UnknownTool) return rpcError(msg.id, -32602, `Unknown tool: ${name}`)
        // Tool errors go back to the model as a result it can read; internals stay in the log.
        if (!(err instanceof ToolError)) console.error('mcp tool failed', name, String(err))
        return reply({ content: [{ type: 'text', text: err instanceof ToolError ? err.message : 'Something went wrong. Please try again.' }], isError: true })
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`)
  }
}
