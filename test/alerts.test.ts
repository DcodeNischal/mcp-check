import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { atomFeed, eventText, sign, webhookBody, webhookFormat, type ServerEvent } from '../src/worker/alerts'

const ORIGIN = 'https://mcp.nischaldhakal.com.np'
const event = (over: Partial<ServerEvent> = {}): ServerEvent => ({
  seq: 7,
  server_id: 'abcdefgh2345',
  type: 'grade_changed',
  grade: 'A',
  prev_grade: 'C',
  score: 93,
  prev_score: 74,
  at: '2026-11-23T01:00:00.000Z',
  name: 'Docs <Search> & more',
  url: 'https://docs.example.com/mcp',
  ...over,
})
const server = { id: 'abcdefgh2345', url: 'https://docs.example.com/mcp', name: 'Docs' }

describe('alert text', () => {
  it('describes each kind of event', () => {
    expect(eventText(event())).toBe('Docs <Search> & more improved from C to A (74 → 93/100)')
    expect(eventText(event({ grade: 'D', prev_grade: 'B', score: 61, prev_score: 85 }))).toBe('Docs <Search> & more dropped from B to D (85 → 61/100)')
    expect(eventText(event({ type: 'listed', prev_grade: null, prev_score: null }))).toBe('Docs <Search> & more was added to the directory with grade A (93/100)')
    expect(eventText(event({ type: 'unreachable', name: null }))).toBe('docs.example.com stopped responding to weekly checks and was removed from the directory')
  })
})

describe('webhooks', () => {
  it('detects Slack and Discord', () => {
    expect(webhookFormat('https://hooks.slack.com/services/T0/B0/x')).toBe('slack')
    expect(webhookFormat('https://discord.com/api/webhooks/1/abc')).toBe('discord')
    expect(webhookFormat('https://discord.com/channels/1')).toBe('json')
    expect(webhookFormat('https://example.com/hook')).toBe('json')
  })

  it('formats each kind of payload', () => {
    // Server names can't add Slack links or ping a Discord channel.
    expect(JSON.parse(webhookBody('slack', event(), ORIGIN, server))).toEqual({ text: `Docs &lt;Search&gt; &amp; more improved from C to A (74 → 93/100): ${ORIGIN}/r/abcdefgh2345` })
    expect(JSON.parse(webhookBody('discord', event({ name: '@everyone hi' }), ORIGIN, server))).toMatchObject({ username: 'MCP Check', content: expect.stringContaining('@everyone hi'), allowed_mentions: { parse: [] } })
    expect(JSON.parse(webhookBody('json', event(), ORIGIN, server))).toEqual({
      type: 'grade_changed',
      server: { id: 'abcdefgh2345', url: 'https://docs.example.com/mcp', name: 'Docs', reportUrl: `${ORIGIN}/r/abcdefgh2345` },
      grade: 'A',
      previousGrade: 'C',
      score: 93,
      previousScore: 74,
      message: 'Docs <Search> & more improved from C to A (74 → 93/100)',
      at: '2026-11-23T01:00:00.000Z',
    })
    expect(JSON.parse(webhookBody('json', 'ping', ORIGIN, server))).toMatchObject({ type: 'ping', server: { reportUrl: `${ORIGIN}/r/abcdefgh2345` } })
  })

  it('signs bodies with HMAC-SHA256', async () => {
    const body = webhookBody('json', event(), ORIGIN, server)
    expect(await sign('whsec_test', body)).toBe(createHmac('sha256', 'whsec_test').update(body).digest('hex'))
  })
})

describe('feeds', () => {
  it('writes valid, escaped Atom', () => {
    const xml = atomFeed({ origin: ORIGIN, path: '/feed.xml', title: 'MCP Check directory', subtitle: 'Updates', link: `${ORIGIN}/servers`, events: [event()] })
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">')
    expect(xml).toContain('<id>tag:mcp.nischaldhakal.com.np,2026:event/7</id>')
    expect(xml).toContain('<title>Docs &lt;Search&gt; &amp; more improved from C to A (74 → 93/100)</title>')
    expect(xml).toContain(`<link href="${ORIGIN}/r/abcdefgh2345"/>`)
    expect(xml).toContain('<updated>2026-11-23T01:00:00.000Z</updated>')
    expect(xml).not.toMatch(/<Search>/)
    const empty = atomFeed({ origin: ORIGIN, path: '/feed.xml', title: 't', subtitle: 's', link: ORIGIN, events: [] })
    expect(empty).toContain('<updated>1970-01-01T00:00:00.000Z</updated>')
  })
})
