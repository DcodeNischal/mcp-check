// Fake MCP servers as fetch handlers: one per era, plus deliberately flawed variants.
// Tests pass these as the client's `fetch`, so no network is involved.

type Handler = (url: string, init?: RequestInit) => Promise<Response>
type Json = Record<string, unknown>

export const MODERN = '2026-07-28'

export interface ServerOptions {
  tools?: Json[]
  /** Split tools/list into pages of this size. */
  pageSize?: number
  /** Answer with text/event-stream instead of application/json. */
  sse?: boolean
  /** Leak a stack trace in error messages. */
  leaky?: boolean
  /** Delay every response by this many ms. */
  delayMs?: number
  serverInfo?: Json
}

export const goodTools: Json[] = [
  {
    name: 'get_weather',
    title: 'Get weather',
    description: 'Returns the current weather for a city, including temperature and conditions.',
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name, for example "Kathmandu".' } },
      required: ['city'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'delete_note',
    title: 'Delete note',
    description: 'Permanently deletes a note by its id. This cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The note id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
]

export const badTools: Json[] = [
  { name: 'do thing!', inputSchema: { type: 'object', properties: { x: { type: 'strin' } } } },
  { name: 'do thing!', description: 'dup', inputSchema: { type: 'array' } },
  { name: 'noschema', description: 'Has no input schema at all.' },
]

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })

const sseResponse = (messages: unknown[], init: ResponseInit = {}) =>
  new Response(messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join(''), {
    ...init,
    headers: { 'content-type': 'text/event-stream', ...(init.headers ?? {}) },
  })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const h = new Headers(init?.headers)
  return h.get(name) ?? undefined
}

function paged(tools: Json[], cursor: unknown, pageSize?: number) {
  if (!pageSize) return { tools }
  const start = typeof cursor === 'string' ? Number(cursor) : 0
  const page = tools.slice(start, start + pageSize)
  const next = start + pageSize < tools.length ? String(start + pageSize) : undefined
  return { tools: page, ...(next ? { nextCursor: next } : {}) }
}

function stackTrace(message: string) {
  return `${message}\n    at handler (/srv/app/server.js:42:13)\n    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)`
}

/** 2026-07-28: stateless, server/discover, Mcp-Method headers, resultType everywhere. */
export function modernServer(opts: ServerOptions = {}): Handler {
  const tools = opts.tools ?? goodTools
  return async (_url, init) => {
    if (opts.delayMs) await sleep(opts.delayMs)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'POST') return new Response(null, { status: 405 })
    const origin = headerOf(init, 'origin')
    if (origin && origin !== 'https://trusted.example') return new Response('forbidden', { status: 403 })

    let msg: Json
    try {
      msg = JSON.parse(String(init?.body))
    } catch {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: opts.leaky ? stackTrace('Parse error') : 'Parse error' } }, { status: 400 })
    }
    if (msg.id === undefined) return new Response(null, { status: 202 })

    const params = (msg.params ?? {}) as Json
    const meta = (params._meta ?? {}) as Json
    const version = meta['io.modelcontextprotocol/protocolVersion']
    if (version !== MODERN) {
      return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: [MODERN], requested: version } } }, { status: 400 })
    }
    if (headerOf(init, 'mcp-method') !== msg.method) {
      return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32020, message: 'Mcp-Method header mismatch' } }, { status: 400 })
    }

    const reply = (result: Json) => {
      const body = { jsonrpc: '2.0', id: msg.id, result: { resultType: 'complete', ...result } }
      return opts.sse ? sseResponse([{ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }, body]) : json(body)
    }
    const fail = (code: number, message: string) => json({ jsonrpc: '2.0', id: msg.id, error: { code, message: opts.leaky ? stackTrace(message) : message } })

    switch (msg.method) {
      case 'server/discover':
        return reply({
          supportedVersions: [MODERN, '2025-11-25'],
          capabilities: { tools: { listChanged: false } },
          instructions: 'Weather and notes.',
          ttlMs: 60000,
          cacheScope: 'public',
          _meta: { 'io.modelcontextprotocol/serverInfo': opts.serverInfo ?? { name: 'demo-modern', version: '1.2.0' } },
        })
      case 'tools/list':
        return reply({ ...paged(tools, params.cursor, opts.pageSize), ttlMs: 60000, cacheScope: 'public' })
      case 'tools/call': {
        const name = params.name
        if (!tools.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${String(name)}`)
        return reply({ content: [{ type: 'text', text: `called ${String(name)}` }], isError: false })
      }
      default:
        return fail(-32601, `Method not found: ${String(msg.method)}`)
    }
  }
}

/** 2025-11-25 Streamable HTTP: initialize handshake and a session id. */
export function legacyStreamableServer(opts: ServerOptions & { version?: string; requireSession?: boolean } = {}): Handler {
  const tools = opts.tools ?? goodTools
  const sessionId = 'sess-123'
  return async (_url, init) => {
    if (opts.delayMs) await sleep(opts.delayMs)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'DELETE') return new Response(null, { status: 200 })
    if (method !== 'POST') return new Response(null, { status: 405 })
    let msg: Json
    try {
      msg = JSON.parse(String(init?.body))
    } catch {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 })
    }

    if (msg.method === 'initialize') {
      const requested = ((msg.params ?? {}) as Json).protocolVersion
      const version = opts.version ?? (requested === '2025-11-25' || requested === '2025-06-18' ? requested : '2025-06-18')
      return json(
        { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: opts.serverInfo ?? { name: 'demo-legacy', version: '0.9.0' } } },
        { headers: { 'mcp-session-id': sessionId } },
      )
    }
    if ((opts.requireSession ?? true) && headerOf(init, 'mcp-session-id') !== sessionId) {
      // What the TypeScript SDK sends for a request without a session.
      return json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: No valid session ID provided' } }, { status: 400 })
    }
    if (msg.id === undefined) return new Response(null, { status: 202 })

    const params = (msg.params ?? {}) as Json
    const reply = (result: Json) => (opts.sse ? sseResponse([{ jsonrpc: '2.0', id: msg.id, result }]) : json({ jsonrpc: '2.0', id: msg.id, result }))
    if (msg.method === 'tools/list') return reply(paged(tools, params.cursor, opts.pageSize))
    if (msg.method === 'tools/call') return reply({ content: [{ type: 'text', text: 'ok' }] })
    return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
  }
}

/** 2024-11-05 HTTP+SSE: GET opens a stream, first event is `endpoint`, responses arrive on the stream. */
export function legacySseServer(opts: ServerOptions = {}): Handler {
  const tools = opts.tools ?? goodTools
  let push: ((message: unknown) => void) | undefined
  return async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = new URL(url).pathname

    if (method === 'GET' && path === '/sse') {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder()
          controller.enqueue(enc.encode('event: endpoint\ndata: /messages?sessionId=abc\n\n'))
          push = (message) => controller.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`))
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    }
    if (method === 'POST' && path === '/sse') return new Response('Method Not Allowed', { status: 405 })
    if (method === 'POST' && path === '/messages') {
      const msg = JSON.parse(String(init?.body)) as Json
      if (msg.id !== undefined) {
        const params = (msg.params ?? {}) as Json
        let result: Json | undefined
        if (msg.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'demo-sse', version: '0.1.0' } }
        else if (msg.method === 'tools/list') result = paged(tools, params.cursor, opts.pageSize)
        queueMicrotask(() => push?.(result ? { jsonrpc: '2.0', id: msg.id, result } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }))
      }
      return new Response('Accepted', { status: 202 })
    }
    return new Response('Not Found', { status: 404 })
  }
}

/** A modern server behind OAuth, with protected-resource and authorization-server metadata. */
export function protectedServer(opts: { resourceMetadataHeader?: boolean; pkce?: boolean; cimd?: boolean; dcr?: boolean; issuerMismatch?: boolean } = {}): Handler {
  const as = 'https://auth.example.com'
  return async (url, init) => {
    const u = new URL(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (u.origin === 'https://mcp.example.com' && u.pathname === '/mcp' && method === 'POST') {
      const challenge = (opts.resourceMetadataHeader ?? true)
        ? 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="read"'
        : 'Bearer'
      return new Response('unauthorized', { status: 401, headers: { 'www-authenticate': challenge } })
    }
    if (u.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json({ resource: 'https://mcp.example.com/mcp', authorization_servers: [as], scopes_supported: ['read'] })
    }
    if (u.origin === as && u.pathname === '/.well-known/oauth-authorization-server') {
      return json({
        issuer: opts.issuerMismatch ? 'https://evil.example.com' : as,
        authorization_endpoint: `${as}/authorize`,
        token_endpoint: `${as}/token`,
        ...((opts.pkce ?? true) ? { code_challenge_methods_supported: ['S256'] } : {}),
        ...((opts.cimd ?? true) ? { client_id_metadata_document_supported: true } : {}),
        ...(opts.dcr ? { registration_endpoint: `${as}/register` } : {}),
      })
    }
    return new Response('not found', { status: 404 })
  }
}

/** Routes requests by URL prefix to different handlers. */
export function route(routes: Record<string, Handler>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    for (const [prefix, handler] of Object.entries(routes)) if (url.startsWith(prefix)) return handler(url, init)
    return new Response('no route', { status: 502 })
  }) as typeof fetch
}

/** Wrap a handler as a fetch implementation. */
export const asFetch = (handler: Handler): typeof fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    return handler(url, init)
  }) as typeof fetch
