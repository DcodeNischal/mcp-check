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
