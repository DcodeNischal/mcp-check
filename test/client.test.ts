import { describe, expect, it } from 'vitest'
import { McpClient } from '../src/mcp/client'
import type { Tool } from '../src/mcp/types'
import { asFetch, goodTools, legacySseServer, legacyStreamableServer, modernServer, protectedServer } from './fixtures/servers'

const URL_ = 'https://mcp.example.com/mcp'

describe('era detection', () => {
  it('connects to a modern (2026-07-28) server with server/discover', async () => {
    const client = new McpClient(URL_, { fetch: asFetch(modernServer()) })
    const res = await client.connect()
    expect(res.ok).toBe(true)
    expect(res.era).toBe('modern')
    expect(res.version).toBe('2026-07-28')
    expect(res.serverInfo).toEqual({ name: 'demo-modern', version: '1.2.0' })
    expect(res.steps).toHaveLength(1)
    const sent = client.log[0]!
    expect(sent.rpcMethod).toBe('server/discover')
  })

  it('falls back to initialize for a 2025-11-25 server, and keeps the session id', async () => {
    const client = new McpClient(URL_, { fetch: asFetch(legacyStreamableServer()) })
    const res = await client.connect()
    expect(res.ok).toBe(true)
    expect(res.era).toBe('legacy-streamable')
    expect(res.version).toBe('2025-11-25')
    expect(res.sessionId).toBe('sess-123')
    expect(res.initializedStatus).toBe(202)
    expect(res.steps.map((s) => s.attempt)).toEqual(['modern', 'legacy-initialize'])
    const tools = await client.listAll<Tool>('tools/list', 'tools')
    expect(tools.items.map((t) => t.name)).toEqual(goodTools.map((t) => t.name))
    await client.close()
    expect(client.log.at(-1)?.method).toBe('DELETE')
  })

  it('accepts a legacy server that answers with an older version', async () => {
    const client = new McpClient(URL_, { fetch: asFetch(legacyStreamableServer({ version: '2025-03-26' })) })
    const res = await client.connect()
    expect(res.era).toBe('legacy-streamable')
    expect(res.version).toBe('2025-03-26')
  })

  it('falls back to the deprecated HTTP+SSE transport', async () => {
    const client = new McpClient('https://mcp.example.com/sse', { fetch: asFetch(legacySseServer()) })
    const res = await client.connect()
    expect(res.ok).toBe(true)
    expect(res.era).toBe('legacy-sse')
    expect(res.version).toBe('2024-11-05')
    expect(res.steps.map((s) => s.attempt)).toEqual(['modern', 'legacy-initialize', 'sse-get'])
    const tools = await client.listAll<Tool>('tools/list', 'tools')
    expect(tools.items).toHaveLength(2)
    await client.close()
  })

  it('reports credentials required with the WWW-Authenticate challenge', async () => {
    const client = new McpClient(URL_, { fetch: asFetch(protectedServer()) })
    const res = await client.connect()
    expect(res.ok).toBe(false)
    expect(res.auth?.status).toBe(401)
    expect(res.auth?.wwwAuthenticate).toContain('resource_metadata=')
  })

  it('reports a clear error when nothing speaks MCP', async () => {
    const client = new McpClient(URL_, { fetch: asFetch(async () => new Response('<html>hi</html>', { status: 200, headers: { 'content-type': 'text/html' } })) })
    const res = await client.connect()
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/did not respond like any MCP transport/)
  })

  it('times out instead of hanging', async () => {
    const client = new McpClient(URL_, { fetch: asFetch(modernServer({ delayMs: 500 })), timeoutMs: 50 })
    const res = await client.connect()
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Timed out/)
  })
})

describe('requests', () => {
  it('follows pagination across pages', async () => {
    const tools = Array.from({ length: 7 }, (_, i) => ({ name: `t${i}`, description: 'x', inputSchema: { type: 'object' } }))
    const client = new McpClient(URL_, { fetch: asFetch(modernServer({ tools, pageSize: 3 })) })
    await client.connect()
    const res = await client.listAll<Tool>('tools/list', 'tools')
    expect(res.items).toHaveLength(7)
    expect(res.pages).toBe(3)
  })

  it('reads responses sent as an SSE stream', async () => {
    const client = new McpClient(URL_, { fetch: asFetch(modernServer({ sse: true })) })
    const res = await client.connect()
    expect(res.era).toBe('modern')
    const call = await client.callTool('get_weather', { city: 'Kathmandu' })
    expect(call.result?.content).toEqual([{ type: 'text', text: 'called get_weather' }])
    // The progress notification before the response is kept in the log too.
    expect(call.exchange.messages).toHaveLength(2)
  })

  it('sends Mcp-Method and Mcp-Name headers in the modern era', async () => {
    let seen: Headers | undefined
    const inner = modernServer()
    const client = new McpClient(URL_, {
      fetch: asFetch(async (url, init) => {
        seen = new Headers(init?.headers)
        return inner(url, init)
      }),
    })
    await client.connect()
    await client.callTool('get_weather', { city: 'Pokhara' })
    expect(seen?.get('mcp-method')).toBe('tools/call')
    expect(seen?.get('mcp-name')).toBe('get_weather')
    expect(seen?.get('mcp-protocol-version')).toBe('2026-07-28')
  })

  it('never records the Authorization header in the log', async () => {
    const client = new McpClient(URL_, { fetch: asFetch(modernServer()), headers: { Authorization: 'Bearer secret-token' } })
    await client.connect()
    expect(JSON.stringify(client.log)).not.toContain('secret-token')
  })
})
