import { describe, expect, it } from 'vitest'
import { parseRegistryPage, pickHosts } from '../src/worker/registry'

const official = (extra: Record<string, unknown> = {}) => ({ 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true, ...extra } })
const entry = (name: string, remotes: unknown[], meta = official(), extra: Record<string, unknown> = {}) => ({ server: { name, title: `${name} title`, description: `${name} does things`, version: '1.0.0', remotes, ...extra }, _meta: meta })

describe('registry import', () => {
  it('keeps the latest active version with a usable public URL', () => {
    const page = {
      servers: [
        entry('io.example/old', [{ type: 'streamable-http', url: 'https://a.example.com/mcp' }], official({ isLatest: false })),
        entry('io.example/gone', [{ type: 'streamable-http', url: 'https://b.example.com/mcp' }], official({ status: 'deleted' })),
        entry('io.example/good', [{ type: 'streamable-http', url: 'https://C.Example.com/mcp/' }], official(), { repository: { url: 'https://github.com/example/good', source: 'github' }, websiteUrl: 'https://example.com' }),
        entry('io.example/sse', [{ type: 'sse', url: 'https://d.example.com/sse' }]),
        entry('io.example/local-only', []),
      ],
      metadata: { nextCursor: 'io.example/sse:1.0.0' },
    }
    const { candidates, nextCursor } = parseRegistryPage(page)
    expect(candidates.map((c) => c.registryName)).toEqual(['io.example/good', 'io.example/sse'])
    expect(candidates[0]).toMatchObject({ url: 'https://c.example.com/mcp', host: 'c.example.com', repositoryUrl: 'https://github.com/example/good', websiteUrl: 'https://example.com', title: 'io.example/good title' })
    expect(nextCursor).toBe('io.example/sse:1.0.0')
  })

  it('skips servers that need per-user keys or aren\'t public', () => {
    const { candidates, nextCursor } = parseRegistryPage({
      servers: [
        entry('keyed', [{ type: 'streamable-http', url: 'https://k.example.com/mcp', headers: [{ name: 'X-API-Key', isRequired: true }] }]),
        entry('templated', [{ type: 'streamable-http', url: 'https://{tenant}.example.com/mcp' }]),
        entry('query', [{ type: 'streamable-http', url: 'https://q.example.com/mcp?key=abc' }]),
        entry('private', [{ type: 'streamable-http', url: 'https://10.0.0.5/mcp' }]),
        entry('http', [{ type: 'streamable-http', url: 'http://plain.example.com/mcp' }]),
        entry('stdio', [{ type: 'stdio', url: 'https://x.example.com' }]),
        entry('optional-header', [{ type: 'streamable-http', url: 'https://ok.example.com/mcp', headers: [{ name: 'X-Trace', isRequired: false }] }]),
      ],
      metadata: {},
    })
    expect(candidates.map((c) => c.registryName)).toEqual(['optional-header'])
    expect(nextCursor).toBeUndefined()
  })

  it('picks servers on different hosts, avoiding the last one', () => {
    const rows = [{ host: 'a' }, { host: 'a' }, { host: 'b' }, { host: 'c' }].map((r, i) => ({ ...r, i }))
    expect(pickHosts(rows, '', 2).map((r) => r.i)).toEqual([0, 2])
    expect(pickHosts(rows, 'a', 2).map((r) => r.i)).toEqual([2, 3])
    expect(pickHosts(rows.slice(0, 2), 'a', 2).map((r) => r.i)).toEqual([0])
    expect(pickHosts([], 'a', 2)).toEqual([])
  })

  it('ignores junk input and unsafe links', () => {
    expect(parseRegistryPage(null).candidates).toEqual([])
    expect(parseRegistryPage({ servers: 'nope' }).candidates).toEqual([])
    const { candidates } = parseRegistryPage({ servers: [entry('x', [{ type: 'streamable-http', url: 'https://x.example.com/mcp' }], official(), { repository: { url: 'javascript:alert(1)' }, websiteUrl: 'http://insecure.example.com' })] })
    expect(candidates[0]?.repositoryUrl).toBeNull()
    expect(candidates[0]?.websiteUrl).toBeNull()
  })
})
