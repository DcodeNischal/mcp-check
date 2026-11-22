import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseArgs, renderMarkdown, renderText, verdict, webLink } from '../cli/src/format'
import type { Report } from '../src/checks/types'
import { modernServer } from './fixtures/servers'

const report = (over: Partial<Report> = {}): Report => ({
  url: 'https://mcp.example.com/mcp',
  checkedAt: '2026-11-23T00:00:00.000Z',
  durationMs: 1234,
  connected: true,
  authenticated: false,
  era: 'modern',
  version: '2026-07-28',
  steps: [],
  tools: [{ name: 'a' }, { name: 'b' }],
  prompts: [],
  resources: [],
  resourceTemplates: [],
  checks: [
    { id: 'p', category: 'protocol', title: 'Speaks the protocol', status: 'pass', weight: 3, detail: 'Fine.' },
    { id: 't', category: 'tools', title: 'Tool descriptions', status: 'fail', weight: 3, detail: 'Tool "a" has | no description.', fix: 'Describe it.' },
    { id: 's', category: 'security', title: 'Origin', status: 'warn', weight: 2, detail: 'Accepted a foreign Origin.', fix: 'Check Origin.' },
  ],
  score: 84,
  grade: 'B',
  ...over,
})

describe('command line options', () => {
  it('parses a typical run', () => {
    const p = parseArgs(['https://x.example/mcp', '-H', 'X-Key: abc', '--min-grade=b', '--min-score', '80', '--markdown', '--timeout', '5'], { MCP_CHECK_TOKEN: 'tok' })
    expect(p).toEqual({
      kind: 'run',
      options: { url: 'https://x.example/mcp', headers: { 'X-Key': 'abc', Authorization: 'Bearer tok' }, minGrade: 'B', minScore: 80, format: 'markdown', verbose: false, color: true, timeoutMs: 5000 },
    })
  })

  it('explains bad input', () => {
    expect(parseArgs([])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['u', '--min-grade', 'E'])).toMatchObject({ kind: 'error', message: expect.stringMatching(/A, B, C, D, F/) })
    expect(parseArgs(['u', '-H', 'nocolon'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['u', '--wat'])).toMatchObject({ kind: 'error', message: expect.stringMatching(/Unknown option/) })
    expect(parseArgs(['u', 'v'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' })
    expect(parseArgs(['u'], { NO_COLOR: '1' })).toMatchObject({ options: { color: false } })
  })
})

describe('pass or fail', () => {
  it('compares grade and score to the minimums', () => {
    expect(verdict(report(), {}).exitCode).toBe(0)
    expect(verdict(report(), { minGrade: 'B' }).exitCode).toBe(0)
    expect(verdict(report(), { minGrade: 'A' })).toEqual({ exitCode: 1, message: 'Failed: grade B is below the minimum A.' })
    expect(verdict(report(), { minScore: 90, minGrade: 'C' })).toEqual({ exitCode: 1, message: 'Failed: score 84 is below the minimum 90.' })
    expect(verdict(report({ connected: false, error: 'ECONNREFUSED' }), {})).toEqual({ exitCode: 2, message: "Couldn't check the server: ECONNREFUSED" })
  })
})

describe('reports', () => {
  it('lists problems first and links to the website for public servers', () => {
    const text = renderText(report(), { color: false, verbose: false })
    expect(text).toContain('Grade B  84/100  spec 2026-07-28 (stateless HTTP) · 2 tools · checked in 1.2s')
    expect(text.indexOf('Tool descriptions')).toBeLessThan(text.indexOf('Origin'))
    expect(text).not.toContain('Speaks the protocol')
    expect(text).toContain('1 passed · 1 warning · 1 failed')
    expect(text).toContain('https://mcp.nischaldhakal.com.np/?url=https%3A%2F%2Fmcp.example.com%2Fmcp')
    expect(renderText(report(), { color: false, verbose: true })).toContain('Speaks the protocol')
    expect(webLink('http://localhost:3000/mcp')).toBeUndefined()
  })

  it('writes a Markdown summary with safe table cells', () => {
    const md = renderMarkdown(report(), { exitCode: 1, message: 'Failed: grade B is below the minimum A.' })
    expect(md).toContain('### MCP Check: grade B (84/100) ❌')
    expect(md).toContain('| ❌ | Tool descriptions | Tool "a" has \\| no description. | Describe it. |')
    expect(md).toContain('<details><summary>1 passed check</summary>')
  })
})

// The built command line, end to end, against a server on localhost.
const BIN = fileURLToPath(new URL('../cli/bin/mcp-check.mjs', import.meta.url))
describe.skipIf(!existsSync(BIN))('built command line', () => {
  let server: Server
  let url = ''
  beforeAll(async () => {
    const handler = modernServer()
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const headers = Object.fromEntries(Object.entries(req.headers).filter((e): e is [string, string] => typeof e[1] === 'string'))
      const out = await handler(`http://localhost${req.url}`, { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks).toString() } : {}) })
      res.writeHead(out.status, Object.fromEntries(out.headers))
      res.end(Buffer.from(await out.arrayBuffer()))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://localhost:${(server.address() as AddressInfo).port}/mcp`
  })
  afterAll(() => server?.close())

  const run = (args: string[]) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [BIN, ...args], { env: { ...process.env, NO_COLOR: '1' } }, (err, stdout) => {
        resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: stdout })
      })
    })

  it('grades a local server and passes the minimum', async () => {
    const { code, out } = await run([url, '--min-grade', 'C'])
    expect(out).toMatch(/Grade [AB]/)
    expect(out).toContain('Passed: meets the minimum grade C.')
    expect(code).toBe(0)
  })

  it('fails the run below the minimum, and on an unreachable server', async () => {
    expect((await run([url, '--min-score', '101'])).code).toBe(2)
    const strict = await run([url, '--json', '--min-score', '100'])
    const parsed = JSON.parse(strict.out) as Report & { verdict: { exitCode: number } }
    expect(parsed.verdict.exitCode).toBe(parsed.score >= 100 ? 0 : 1)
    expect(strict.code).toBe(parsed.verdict.exitCode)
    expect((await run(['http://localhost:9/mcp'])).code).toBe(2)
  })
})
