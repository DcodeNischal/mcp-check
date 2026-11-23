import { describe, expect, it } from 'vitest'
import { OWN_MCP_URL, ownProofText } from '../src/worker/mcp-server'
import { hasProof, proofMatches, proofUrl } from '../src/worker/owners'
import { serverId } from '../src/worker/store'

const ID = 'abcdefgh2345'

describe('owner proof', () => {
  it('lives at the domain root', () => {
    expect(proofUrl('https://api.example.com/v1/mcp')).toBe('https://api.example.com/.well-known/mcp-check.txt')
  })

  it('matches only the right action and server', () => {
    expect(proofMatches(`mcp-check: verify ${ID}`, ID, 'verify')).toBe(true)
    expect(proofMatches(`# owners\nmcp-check:verify   ${ID}\nmcp-check: remove other`, ID, 'verify')).toBe(true)
    expect(proofMatches(`mcp-check: remove ${ID}`, ID, 'verify')).toBe(false)
    expect(proofMatches(`mcp-check: verify ${ID}x`, ID, 'verify')).toBe(false)
    expect(proofMatches(`see mcp-check: verify ${ID}`, ID, 'verify')).toBe(false)
    expect(proofMatches(`mcp-check: verify zzzzzzzzzzzz`, ID, 'verify')).toBe(false)
  })

  it('reads the file from the server and fails closed', async () => {
    const serve = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch
    expect(await hasProof('https://mcp.example.com/mcp', ID, 'verify', serve(200, `mcp-check: verify ${ID}\n`))).toBe(true)
    expect(await hasProof('https://mcp.example.com/mcp', ID, 'verify', serve(404, `mcp-check: verify ${ID}`))).toBe(false)
    expect(await hasProof('https://mcp.example.com/mcp', ID, 'verify', (async () => { throw new Error('down') }) as unknown as typeof fetch)).toBe(false)
    // Never fetched from private addresses.
    let called = false
    await hasProof('https://10.0.0.5/mcp', ID, 'verify', (async () => { called = true; return new Response('') }) as unknown as typeof fetch)
    expect(called).toBe(false)
  })
})

describe("MCP Check's own proof file", () => {
  it('verifies MCP Check as the owner of its own server', async () => {
    const text = await ownProofText()
    expect(proofMatches(text, await serverId(OWN_MCP_URL), 'verify')).toBe(true)
    expect(text).not.toMatch(/remove/)
  })
})
