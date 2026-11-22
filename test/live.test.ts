// Real servers on the internet. Skipped unless LIVE=1, so CI and normal runs stay offline.
import { appendFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runCheck } from '../src/checks/run'

const servers = (process.env.LIVE_URLS ?? 'https://mcp.deepwiki.com/mcp,https://docs.mcp.cloudflare.com/mcp,https://api.githubcopilot.com/mcp/').split(',')

describe.runIf(process.env.LIVE === '1')('live servers', () => {
  it.each(servers)('checks %s', async (url) => {
    const r = await runCheck(url, { timeoutMs: 20_000 })
    const summary = {
      url,
      grade: r.grade,
      score: r.score,
      connected: r.connected,
      era: r.era,
      version: r.version,
      server: r.serverInfo ? `${r.serverInfo.name} ${r.serverInfo.version ?? ''}`.trim() : undefined,
      tools: r.tools.length,
      steps: r.steps.map((s) => `${s.attempt}:${s.status ?? '-'} ${s.outcome}`),
      auth: r.auth ? { issuer: r.auth.issuer, pkce: r.auth.pkceS256, cimd: r.auth.clientIdMetadataDocuments, dcr: r.auth.dynamicRegistration } : undefined,
      checks: r.checks.map((c) => `${c.status.padEnd(4)} ${c.id}: ${c.detail.slice(0, 110)}`),
      error: r.error,
    }
    if (process.env.LIVE_OUT) appendFileSync(process.env.LIVE_OUT, `${JSON.stringify(summary, null, 2)}\n`)
    else console.log(JSON.stringify(summary, null, 2))
    expect(r.checkedAt).toBeTruthy()
  }, 120_000)
})
