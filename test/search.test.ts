import { describe, expect, it } from 'vitest'
import { embedText, ftsQuery, fuse, matchedTool, queryWords, toolsText } from '../src/worker/search'

describe('search helpers', () => {
  it('splits a query into safe words', () => {
    expect(queryWords('Send  "email" -- send* a')).toEqual(['send', 'email'])
    expect(queryWords('"); DROP TABLE servers; --')).toEqual(['drop', 'table', 'servers'])
    expect(queryWords('%%__')).toEqual([])
    expect(queryWords('日本語 search')).toEqual(['日本語', 'search'])
  })

  it('builds FTS expressions with stems and prefixes', () => {
    expect(ftsQuery(['send', 'to'], 'all')).toBe('("send" OR "send"*) AND "to"')
    expect(ftsQuery(['send', 'email'], 'any')).toBe('("send" OR "send"*) OR ("email" OR "email"*)')
  })

  it('fuses rankings so items found by both come first', () => {
    expect(fuse([['a', 'b', 'c'], ['c', 'd']])).toEqual(['c', 'a', 'b', 'd'])
    expect(fuse([['x'], []])).toEqual(['x'])
  })

  it('names the tool that matched', () => {
    const tools = 'list_repos: List repositories\nsend_message: Sends an email to a contact\ncreate_draft: Create a draft email'
    expect(matchedTool(['sending', 'email'], tools)).toBe('send_message')
    expect(matchedTool(['draft'], tools)).toBe('create_draft')
    expect(matchedTool(['weather'], tools)).toBeUndefined()
    expect(matchedTool(['email'], null)).toBeUndefined()
  })

  it('stores tools and embedding text compactly', () => {
    const text = toolsText([{ name: 'search', title: 'Search', description: 'Find   things\nfast' }, { name: 'ping' }])
    expect(text).toBe('search: Search. Find things fast\nping:')
    expect(embedText({ name: 'Docs', registry_name: 'io.example/docs', description: 'Docs server', tools_text: text })).toBe(
      'Docs\nio.example/docs\nDocs server\nTools: search: Search. Find things fast; ping:',
    )
  })
})
