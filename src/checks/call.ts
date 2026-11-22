// Run one tool on a server: connect in whatever era it speaks, then call. Stateless by design,
// because a Worker can't keep a session open between the visitor's requests.
import { McpClient } from '../mcp/client'
import type { Exchange } from '../mcp/types'
import { checkTarget } from '../security/target'
import type { CheckOptions } from './run'

export interface CallOutcome {
  ok: boolean
  /** The tools/call result as the server sent it. */
  result?: Record<string, unknown>
  error?: { code?: number; message: string }
  ms?: number
  log: Exchange[]
}

export async function runTool(rawUrl: string, name: string, args: Record<string, unknown>, opts: CheckOptions = {}): Promise<CallOutcome> {
  const target = checkTarget(rawUrl, opts)
  if (!target.ok) return { ok: false, error: { message: target.reason }, log: [] }
  const client = new McpClient(target.url.toString(), { ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.headers ? { headers: opts.headers } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) })
  try {
    const conn = await client.connect()
    if (!conn.ok) {
      const message = conn.auth ? 'The server requires sign-in.' : (conn.error ?? 'Could not connect.')
      return { ok: false, error: { message }, log: client.log }
    }
    const call = await client.callTool(name, args)
    if (call.error) return { ok: false, error: { code: call.error.code, message: call.error.message }, ms: call.exchange.ms, log: client.log }
    if (!call.result) return { ok: false, error: { message: call.exchange.error ?? `No result (HTTP ${call.exchange.status ?? '?'})` }, ms: call.exchange.ms, log: client.log }
    return { ok: true, result: call.result, ms: call.exchange.ms, log: client.log }
  } finally {
    await client.close().catch(() => {})
  }
}
