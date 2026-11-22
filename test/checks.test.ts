import { describe, expect, it } from 'vitest'
import { runCheck } from '../src/checks/run'
import type { Report } from '../src/checks/types'
import { checkTarget } from '../src/security/target'
import { asFetch, badTools, legacySseServer, legacyStreamableServer, modernServer, protectedServer, route } from './fixtures/servers'

const URL_ = 'https://mcp.example.com/mcp'
const byId = (r: Report, id: string) => r.checks.find((c) => c.id === id)

describe('graded reports', () => {
  it('gives a well-built modern server an A with no failures', async () => {
    const r = await runCheck(URL_, { fetch: asFetch(modernServer()) })
    expect(r.connected).toBe(true)
    expect(r.era).toBe('modern')
    expect(r.tools).toHaveLength(2)
    expect(r.checks.filter((c) => c.status === 'fail')).toEqual([])
    expect(r.grade).toBe('A')
    expect(byId(r, 'protocol.era')?.status).toBe('pass')
    expect(byId(r, 'security.origin')?.status).toBe('pass')
    expect(byId(r, 'protocol.unknown-method')?.status).toBe('pass')
    expect(byId(r, 'tools.unknown-tool')?.status).toBe('pass')
  })

  it('flags a legacy server as behind the spec, but still connects and grades it', async () => {
    const r = await runCheck(URL_, { fetch: asFetch(legacyStreamableServer()) })
    expect(r.era).toBe('legacy-streamable')
    expect(byId(r, 'protocol.era')?.status).toBe('warn')
    expect(byId(r, 'protocol.notifications')?.status).toBe('pass')
    expect(byId(r, 'security.origin')?.status).toBe('warn')
    expect(['A', 'B']).toContain(r.grade)
  })

  it('fails the deprecated HTTP+SSE transport on the era check', async () => {
    const r = await runCheck('https://mcp.example.com/sse', { fetch: asFetch(legacySseServer()) })
    expect(r.era).toBe('legacy-sse')
    expect(byId(r, 'protocol.era')?.status).toBe('fail')
    expect(r.tools).toHaveLength(2)
  })

  it('catches broken tool definitions', async () => {
    const r = await runCheck(URL_, { fetch: asFetch(modernServer({ tools: badTools })) })
    expect(byId(r, 'tools.schemas')?.status).toBe('fail')
    expect(byId(r, 'tools.names')?.status).toBe('fail')
    expect(byId(r, 'tools.descriptions')?.status).not.toBe('pass')
    expect(byId(r, 'tools.annotations')?.status).toBe('warn')
    expect(r.grade).not.toBe('A')
  })

  it('catches stack traces leaking in error messages', async () => {
    const r = await runCheck(URL_, { fetch: asFetch(modernServer({ leaky: true })) })
    const leak = byId(r, 'security.error-leaks')
    expect(leak?.status).toBe('fail')
    expect(leak?.detail).toMatch(/stack trace|file path/)
  })

  it('warns about a bloated tool list', async () => {
    const huge = Array.from({ length: 60 }, (_, i) => ({ name: `tool_${i}`, description: 'x'.repeat(2000), inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }))
    const r = await runCheck(URL_, { fetch: asFetch(modernServer({ tools: huge })) })
    expect(['warn', 'fail']).toContain(byId(r, 'tools.size')?.status)
  })

  it('grades slow servers on speed', async () => {
    const r = await runCheck(URL_, { fetch: asFetch(modernServer({ delayMs: 1100 })), timeoutMs: 5000 })
    expect(byId(r, 'performance.connect')?.status).toBe('warn')
  }, 30_000)

  it('reports an unreachable server as F with a clear reason', async () => {
    const r = await runCheck(URL_, { fetch: asFetch(async () => new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } })) })
    expect(r.connected).toBe(false)
    expect(r.grade).toBe('F')
    expect(r.error).toBeTruthy()
  })
})

describe('protected servers', () => {
  const fetchFor = (opts: Parameters<typeof protectedServer>[0] = {}) => route({ 'https://': protectedServer(opts) })

  it('grades a correct OAuth setup without signing in', async () => {
    const r = await runCheck(URL_, { fetch: fetchFor() })
    expect(r.connected).toBe(false)
    expect(r.auth?.required).toBe(true)
    expect(r.auth?.issuer).toBe('https://auth.example.com')
    for (const id of ['auth.challenge', 'auth.resource-metadata', 'auth.as-metadata', 'auth.pkce', 'auth.registration']) {
      expect(byId(r, id)?.status, id).toBe('pass')
    }
    expect(byId(r, 'tools.listed')?.status).toBe('info')
    expect(r.partial).toBe(true)
  })

  it('finds metadata through the well-known fallback when the challenge omits it', async () => {
    const r = await runCheck(URL_, { fetch: fetchFor({ resourceMetadataHeader: false }) })
    expect(byId(r, 'auth.challenge')?.status).toBe('warn')
    expect(byId(r, 'auth.resource-metadata')?.status).toBe('pass')
  })

  it('fails missing PKCE and a mismatched issuer, and warns on registration-only setups', async () => {
    expect(byId(await runCheck(URL_, { fetch: fetchFor({ pkce: false }) }), 'auth.pkce')?.status).toBe('fail')
    expect(byId(await runCheck(URL_, { fetch: fetchFor({ issuerMismatch: true }) }), 'auth.as-metadata')?.status).toBe('fail')
    expect(byId(await runCheck(URL_, { fetch: fetchFor({ cimd: false, dcr: true }) }), 'auth.registration')?.status).toBe('warn')
  })

  it('never puts credentials in the report', async () => {
    const r = await runCheck(URL_, { fetch: asFetch(modernServer()), headers: { Authorization: 'Bearer top-secret' } })
    expect(r.authenticated).toBe(true)
    expect(JSON.stringify(r)).not.toContain('top-secret')
  })
})

describe('target guard', () => {
  it.each([
    ['http://mcp.example.com/mcp', 'https'],
    ['https://localhost/mcp', 'Local'],
    ['https://127.0.0.1/mcp', 'Private'],
    ['https://10.1.2.3/mcp', 'Private'],
    ['https://169.254.169.254/latest/meta-data', 'Private'],
    ['https://[::1]/mcp', 'Private'],
    ['https://printer.local/mcp', 'Local'],
    ['https://mcp.example.com:8443/mcp', 'port'],
    ['https://user:pass@mcp.example.com/mcp', 'credentials'],
    ['not a url', 'valid URL'],
  ])('rejects %s', (url, why) => {
    const v = checkTarget(url)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toContain(why)
  })

  it('accepts public https URLs, and local ones only when allowed', () => {
    expect(checkTarget('https://mcp.example.com/mcp').ok).toBe(true)
    expect(checkTarget('http://localhost:3000/mcp', { allowLocal: true }).ok).toBe(true)
  })

  it('refuses to check a blocked URL at all', async () => {
    let called = false
    const r = await runCheck('https://127.0.0.1/mcp', { fetch: asFetch(async () => { called = true; return new Response() }) })
    expect(called).toBe(false)
    expect(r.error).toMatch(/Private/)
  })
})
