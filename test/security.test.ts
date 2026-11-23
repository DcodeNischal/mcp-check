import { describe, expect, it } from 'vitest'
import { checkTarget } from '../src/security/target'
import { rateKey, targetKey } from '../src/worker/ratelimit'

describe('rate-limit keys', () => {
  it('keys IPv6 visitors by their /64 and IPv4 by address', () => {
    expect(rateKey('203.0.113.7')).toBe('203.0.113.7')
    expect(rateKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64')
    expect(rateKey('2001:db8:1:2:ffff:eeee:dddd:cccc')).toBe('2001:db8:1:2::/64')
    expect(rateKey('2001:db8::5')).toBe('2001:db8:0:0::/64')
    expect(rateKey(undefined)).toBe('unknown')
    expect(targetKey('https://Mcp.Example.com:443/mcp')).toBe('target:mcp.example.com')
  })
})

describe('URL guard', () => {
  it('refuses IPv6 forms that hide private or special addresses', () => {
    for (const url of ['https://[::127.0.0.1]/', 'https://[::7f00:1]/', 'https://[2002:a00::1]/', 'https://[fec0::1]/', 'https://[ff02::1]/']) {
      expect(checkTarget(url).ok, url).toBe(false)
    }
    expect(checkTarget('https://[2606:4700::1]/').ok).toBe(true)
  })
})

describe('deprecated SSE transport', () => {
  it('never follows an endpoint event to another origin', async () => {
    const { runCheck } = await import('../src/checks/run')
    const seen: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      seen.push(url)
      if ((init?.method ?? 'GET') === 'GET') {
        const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('event: endpoint\ndata: https://victim.example/internal\n\n')) } })
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response('not here', { status: 405 })
    }) as typeof fetch
    const report = await runCheck('https://mcp.example.com/sse', { fetch: fetchImpl, timeoutMs: 2000 })
    expect(report.connected).toBe(false)
    expect(seen.some((u) => u.startsWith('https://victim.example'))).toBe(false)
  })
})

describe("MCP Check's own zone", () => {
  it('is out of reach except the MCP host itself', async () => {
    const { reserveZone } = await import('../src/security/target')
    reserveZone('nischaldhakal.com.np', ['mcp.nischaldhakal.com.np'])
    expect(checkTarget('https://nischaldhakal.com.np/api/guestbook').ok).toBe(false)
    expect(checkTarget('https://www.nischaldhakal.com.np/').ok).toBe(false)
    expect(checkTarget('https://mcp.nischaldhakal.com.np/mcp').ok).toBe(true)
    expect(checkTarget('https://notnischaldhakal.com.np/').ok).toBe(true)
    // The CLI (allowLocal) isn't affected.
    expect(checkTarget('https://nischaldhakal.com.np/', { allowLocal: true }).ok).toBe(true)
  })
})

describe('registry namespaces and links', () => {
  it('only trusts what the namespace proves', async () => {
    const { nsMatchesHost, trustedRegistryLinks } = await import('../src/worker/registry')
    expect(nsMatchesHost('np.com.nischaldhakal/mcp-check', 'mcp.nischaldhakal.com.np')).toBe(true)
    expect(nsMatchesHost('app.linear/mcp', 'mcp.linear.app')).toBe(true)
    expect(nsMatchesHost('io.github.someone/server', 'mcp.linear.app')).toBe(false)
    expect(nsMatchesHost('com.evil/server', 'mcp.linear.app')).toBe(false)
    // A squatter's links on someone else's server are hidden; the owner's own are kept.
    expect(trustedRegistryLinks('io.github.attacker/x', 'https://mcp.victim.com/mcp', 'https://evil.example', 'https://github.com/attacker/x')).toEqual({ websiteUrl: null, repositoryUrl: 'https://github.com/attacker/x' })
    expect(trustedRegistryLinks('io.github.attacker/x', 'https://mcp.victim.com/mcp', 'https://victim.com', 'https://github.com/victim/x')).toEqual({ websiteUrl: 'https://victim.com', repositoryUrl: null })
    expect(trustedRegistryLinks('com.victim/mcp', 'https://mcp.victim.com/mcp', 'https://docs.example.org', 'https://gitlab.com/v/x')).toEqual({ websiteUrl: 'https://docs.example.org', repositoryUrl: 'https://gitlab.com/v/x' })
  })
})
