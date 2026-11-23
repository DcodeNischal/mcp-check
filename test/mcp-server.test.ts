import { describe, expect, it } from 'vitest'
import { runCheck } from '../src/checks/run'
import { handleMcp, OWN_MCP_URL, TOOLS, type McpContext } from '../src/worker/mcp-server'

// The protocol paths never touch the database or the rate limiter.
const ctx = { env: {} as McpContext['env'] } satisfies McpContext
const asFetch = ((input: RequestInfo | URL, init?: RequestInit) => handleMcp(new Request(input, init), ctx)) as typeof fetch
const post = (body: unknown, headers: Record<string, string> = {}) =>
  handleMcp(new Request(OWN_MCP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }), ctx)

describe("MCP Check's own MCP server", () => {
  it('earns an A from MCP Check, with no warnings or failures', async () => {
    const report = await runCheck(OWN_MCP_URL, { fetch: asFetch })
    const problems = report.checks.filter((c) => c.status === 'warn' || c.status === 'fail').map((c) => `${c.id}: ${c.detail}`)
    expect(problems.filter((p) => !p.startsWith('performance.'))).toEqual([])
    expect(report.grade).toBe('A')
    expect(report.era).toBe('modern')
    expect(report.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name))
  })

  it('speaks the older Streamable HTTP versions too', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
    expect(await res.json()).toMatchObject({ result: { protocolVersion: '2025-06-18', serverInfo: { name: 'mcp-check' } } })
    const unknown = await post({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
    expect(await unknown.json()).toMatchObject({ result: { protocolVersion: '2025-11-25' } })
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)
  })

  it('refuses other websites, other methods and bad input', async () => {
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://mcp.nischaldhakal.com.np' })).status).toBe(200)
    expect((await handleMcp(new Request(OWN_MCP_URL), ctx)).status).toBe(405)
    expect(await (await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).json()).toMatchObject({ error: { code: -32600 } })
    expect(await (await post({ jsonrpc: '2.0', id: 1, method: 'nope' })).json()).toMatchObject({ error: { code: -32601 } })
    expect(await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } })).json()).toMatchObject({ error: { code: -32602 } })
    const modern = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }, { 'Mcp-Method': 'ping' })
    expect(await modern.json()).toMatchObject({ error: { code: -32020 } })
  })

  it('answers a bad check_server call as a readable tool error', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_server', arguments: {} } })
    expect(await res.json()).toMatchObject({ result: { isError: true, content: [{ type: 'text', text: expect.stringContaining('Give the server URL') }] } })
  })
})
