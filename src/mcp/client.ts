// An MCP client built for checking: it speaks all three eras (see docs/spec-notes.md), records
// how it got connected, and never hides what the server actually sent.
import { readSse } from './sse'
import {
  ERROR,
  LEGACY_VERSIONS,
  META,
  MODERN_VERSION,
  SSE_VERSION,
  type Era,
  type Exchange,
  type Implementation,
  type JsonRpcId,
  type JsonRpcResponse,
} from './types'
import { Wire, parseJson, type PostResult, type WireOptions } from './wire'

export const CLIENT_INFO = { name: 'mcp-check', title: 'MCP Check', version: '0.1.0', websiteUrl: 'https://mcp.nischaldhakal.com.np' }

export interface DetectionStep {
  attempt: 'modern' | 'legacy-initialize' | 'sse-get'
  status?: number
  outcome: string
}

export interface ConnectResult {
  ok: boolean
  era?: Era
  version?: string
  serverInfo?: Implementation
  capabilities?: Record<string, unknown>
  instructions?: string
  steps: DetectionStep[]
  /** Set when the server asked for credentials (401/403). */
  auth?: { status: number; wwwAuthenticate?: string }
  /** Status of notifications/initialized (legacy streamable only). */
  initializedStatus?: number
  sessionId?: string
  error?: string
}

export interface RequestResult extends PostResult {
  result?: Record<string, unknown>
  error?: JsonRpcResponse['error']
}

export interface ListResult<T> {
  items: T[]
  pages: number
  truncated: boolean
  error?: string
}

const MAX_PAGES = 10
const MAX_ITEMS = 1000

export class McpClient {
  readonly wire: Wire
  era?: Era
  version?: string
  private sessionId?: string
  private nextId = 1
  private sse?: SseChannel

  constructor(readonly url: string, opts: WireOptions = {}) {
    this.wire = new Wire(opts)
  }

  get log(): Exchange[] {
    return this.wire.log
  }

  /** Work out which era the server speaks and connect with it. */
  async connect(): Promise<ConnectResult> {
    const steps: DetectionStep[] = []

    // 1. Modern (2026-07-28): stateless, starts with server/discover.
    const modern = await this.wire.post(this.url, this.modernBody('server/discover', {}), this.modernHeaders('server/discover'))
    const status = modern.exchange.status
    if (modern.exchange.error && status === undefined) {
      steps.push({ attempt: 'modern', outcome: modern.exchange.error })
      return { ok: false, steps, error: modern.exchange.error }
    }
    if (status === 401 || status === 403) {
      steps.push({ attempt: 'modern', status, outcome: 'credentials required' })
      return { ok: false, steps, auth: { status, wwwAuthenticate: modern.exchange.responseHeaders['www-authenticate'] } }
    }

    const result = modern.response?.result
    const error = modern.response?.error
    let supported: string[] | undefined

    if (result && Array.isArray(result.supportedVersions)) {
      supported = result.supportedVersions.filter((v): v is string => typeof v === 'string')
      if (supported.includes(MODERN_VERSION)) {
        steps.push({ attempt: 'modern', status, outcome: 'server/discover answered' })
        this.era = 'modern'
        this.version = MODERN_VERSION
        const meta = (result._meta ?? {}) as Record<string, unknown>
        return {
          ok: true,
          era: 'modern',
          version: MODERN_VERSION,
          steps,
          ...(isImplementation(meta[META.serverInfo]) ? { serverInfo: meta[META.serverInfo] as Implementation } : {}),
          ...(isObject(result.capabilities) ? { capabilities: result.capabilities } : {}),
          ...(typeof result.instructions === 'string' ? { instructions: result.instructions } : {}),
        }
      }
      steps.push({ attempt: 'modern', status, outcome: `server/discover lists ${supported.join(', ') || 'no versions'}` })
    } else if (error?.code === ERROR.unsupportedVersion) {
      const data = (error.data ?? {}) as { supported?: unknown }
      supported = Array.isArray(data.supported) ? data.supported.filter((v): v is string => typeof v === 'string') : []
      steps.push({ attempt: 'modern', status, outcome: `unsupported version; server supports ${supported.join(', ') || 'none listed'}` })
    } else {
      const why = error ? `JSON-RPC error ${error.code}` : status !== undefined ? `HTTP ${status}` : 'no response'
      steps.push({ attempt: 'modern', status, outcome: `not a modern server (${why})` })
    }

    // 2. Legacy Streamable HTTP: initialize handshake.
    const wanted = supported?.find((v) => (LEGACY_VERSIONS as readonly string[]).includes(v)) ?? LEGACY_VERSIONS[0]
    const legacy = await this.legacyInitialize(wanted)
    steps.push(legacy.step)
    if (legacy.auth) return { ok: false, steps, auth: legacy.auth }
    if (legacy.ok) return { ...legacy.result, steps }

    // 3. Deprecated HTTP+SSE: GET, expect an `endpoint` event.
    const sse = await this.connectSse()
    steps.push(sse.step)
    if (sse.auth) return { ok: false, steps, auth: sse.auth }
    if (sse.ok) return { ...sse.result, steps }

    return { ok: false, steps, error: 'The server did not respond like any MCP transport.' }
  }

  /** Send a request in the connected era. */
  async request(method: string, params: Record<string, unknown> = {}, name?: string, extraHeaders: Record<string, string> = {}): Promise<RequestResult> {
    let posted: PostResult
    if (this.era === 'modern') {
      posted = await this.wire.post(this.url, this.modernBody(method, params), { ...this.modernHeaders(method, name), ...extraHeaders })
    } else if (this.era === 'legacy-sse' && this.sse) {
      posted = await this.sse.send(this.body(method, params))
    } else {
      posted = await this.wire.post(this.url, this.body(method, params), { ...this.legacyHeaders(), ...extraHeaders })
    }
    const result = posted.response?.result
    const error = posted.response?.error
    return { ...posted, ...(isObject(result) ? { result } : {}), ...(error ? { error } : {}) }
  }

  /** Send a raw body as-is (used by checks to probe error handling). */
  async raw(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<PostResult> {
    const base = this.era === 'modern' ? this.modernHeaders(String(body.method ?? 'unknown')) : this.legacyHeaders()
    if (this.era === 'legacy-sse' && this.sse) return this.sse.send(body)
    return this.wire.post(this.url, body, { ...base, ...headers })
  }

  /** Follow nextCursor until done, with page and item caps. */
  async listAll<T>(method: string, key: string): Promise<ListResult<T>> {
    const items: T[] = []
    let cursor: string | undefined
    let pages = 0
    while (pages < MAX_PAGES) {
      const res = await this.request(method, cursor ? { cursor } : {})
      pages++
      if (res.error) return { items, pages, truncated: false, error: `${res.error.code}: ${res.error.message}` }
      if (!res.result) return { items, pages, truncated: false, error: res.exchange.error ?? `HTTP ${res.exchange.status ?? '?'}: no result` }
      const page = res.result[key]
      if (!Array.isArray(page)) return { items, pages, truncated: false, error: `result.${key} is not an array` }
      items.push(...(page as T[]))
      if (items.length >= MAX_ITEMS) return { items: items.slice(0, MAX_ITEMS), pages, truncated: true }
      cursor = typeof res.result.nextCursor === 'string' && res.result.nextCursor ? res.result.nextCursor : undefined
      if (!cursor) return { items, pages, truncated: false }
    }
    return { items, pages, truncated: true }
  }

  callTool(name: string, args: Record<string, unknown>) {
    return this.request('tools/call', { name, arguments: args }, name)
  }

  /** End the session politely (legacy streamable) or drop the stream (SSE). */
  async close() {
    if (this.era === 'legacy-streamable' && this.sessionId) {
      await this.wire.request('DELETE', this.url, this.legacyHeaders())
    }
    this.sse?.close()
  }

  // --- era-specific plumbing ---------------------------------------------------------------

  private id(): JsonRpcId {
    return this.nextId++
  }

  private body(method: string, params: Record<string, unknown>) {
    return { jsonrpc: '2.0', id: this.id(), method, params }
  }

  private modernBody(method: string, params: Record<string, unknown>) {
    return this.body(method, {
      ...params,
      _meta: {
        [META.protocolVersion]: MODERN_VERSION,
        [META.clientCapabilities]: {},
        [META.clientInfo]: CLIENT_INFO,
      },
    })
  }

  private modernHeaders(method: string, name?: string): Record<string, string> {
    return { 'MCP-Protocol-Version': MODERN_VERSION, 'Mcp-Method': method, ...(name ? { 'Mcp-Name': name } : {}) }
  }

  private legacyHeaders(): Record<string, string> {
    const headers: Record<string, string> = {}
    // MCP-Protocol-Version arrived in 2025-06-18.
    if (this.version && this.version >= '2025-06-18') headers['MCP-Protocol-Version'] = this.version
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId
    return headers
  }

  private initializeParams(version: string) {
    return { protocolVersion: version, capabilities: {}, clientInfo: CLIENT_INFO }
  }

  private async legacyInitialize(version: string): Promise<
    | { ok: true; step: DetectionStep; result: Omit<ConnectResult, 'steps'>; auth?: undefined }
    | { ok: false; step: DetectionStep; auth?: ConnectResult['auth'] }
  > {
    const res = await this.wire.post(this.url, this.body('initialize', this.initializeParams(version)))
    const status = res.exchange.status
    if (status === 401 || status === 403) {
      return { ok: false, step: { attempt: 'legacy-initialize', status, outcome: 'credentials required' }, auth: { status, wwwAuthenticate: res.exchange.responseHeaders['www-authenticate'] } }
    }
    const result = res.response?.result
    if (!result || typeof result.protocolVersion !== 'string') {
      const why = res.response?.error ? `JSON-RPC error ${res.response.error.code}` : res.exchange.error ?? `HTTP ${status ?? '?'}`
      return { ok: false, step: { attempt: 'legacy-initialize', ...(status !== undefined ? { status } : {}), outcome: `no initialize result (${why})` } }
    }

    this.era = 'legacy-streamable'
    this.version = result.protocolVersion
    const sessionId = res.exchange.responseHeaders['mcp-session-id']
    if (sessionId) this.sessionId = sessionId
    const initialized = await this.wire.post(this.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, this.legacyHeaders())

    return {
      ok: true,
      step: { attempt: 'legacy-initialize', ...(status !== undefined ? { status } : {}), outcome: `initialize answered with ${result.protocolVersion}` },
      result: {
        ok: true,
        era: 'legacy-streamable',
        version: result.protocolVersion,
        ...(isImplementation(result.serverInfo) ? { serverInfo: result.serverInfo } : {}),
        ...(isObject(result.capabilities) ? { capabilities: result.capabilities } : {}),
        ...(typeof result.instructions === 'string' ? { instructions: result.instructions } : {}),
        ...(initialized.exchange.status !== undefined ? { initializedStatus: initialized.exchange.status } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
    }
  }

  private async connectSse(): Promise<
    | { ok: true; step: DetectionStep; result: Omit<ConnectResult, 'steps'>; auth?: undefined }
    | { ok: false; step: DetectionStep; auth?: ConnectResult['auth'] }
  > {
    const channel = new SseChannel(this.wire, this.url)
    const opened = await channel.open()
    if (opened.auth) return { ok: false, step: { attempt: 'sse-get', status: opened.auth.status, outcome: 'credentials required' }, auth: opened.auth }
    if (!opened.ok) return { ok: false, step: { attempt: 'sse-get', ...(opened.status !== undefined ? { status: opened.status } : {}), outcome: opened.reason } }

    this.sse = channel
    this.era = 'legacy-sse'
    this.version = SSE_VERSION
    const init = await channel.send(this.body('initialize', this.initializeParams(SSE_VERSION)))
    const result = init.response?.result
    if (!result || typeof result.protocolVersion !== 'string') {
      channel.close()
      this.sse = undefined
      this.era = undefined
      return { ok: false, step: { attempt: 'sse-get', status: opened.status, outcome: 'endpoint event received, but initialize failed' } }
    }
    this.version = result.protocolVersion
    await channel.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return {
      ok: true,
      step: { attempt: 'sse-get', status: opened.status, outcome: `endpoint event received; initialize answered with ${result.protocolVersion}` },
      result: {
        ok: true,
        era: 'legacy-sse',
        version: result.protocolVersion,
        ...(isImplementation(result.serverInfo) ? { serverInfo: result.serverInfo } : {}),
        ...(isObject(result.capabilities) ? { capabilities: result.capabilities } : {}),
        ...(typeof result.instructions === 'string' ? { instructions: result.instructions } : {}),
      },
    }
  }
}

/** The deprecated HTTP+SSE transport: one long GET stream for responses, POSTs to the `endpoint`. */
class SseChannel {
  private endpoint?: string
  private pending = new Map<JsonRpcId, (message: JsonRpcResponse) => void>()
  private exchanges = new Map<JsonRpcId, Exchange>()
  private readonly stop = new AbortController()
  private closed = false

  constructor(private readonly wire: Wire, private readonly url: string) {}

  async open(): Promise<{ ok: true; status: number; auth?: undefined } | { ok: false; status?: number; reason: string; auth?: ConnectResult['auth'] }> {
    const { exchange, res } = await this.wire.request('GET', this.url, { Accept: 'text/event-stream' })
    if (!res) return { ok: false, reason: exchange.error ?? 'no response' }
    if (res.status === 401 || res.status === 403) {
      res.body?.cancel().catch(() => {})
      return { ok: false, status: res.status, reason: 'credentials required', auth: { status: res.status, wwwAuthenticate: exchange.responseHeaders['www-authenticate'] } }
    }
    if (!res.ok || !res.body || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      res.body?.cancel().catch(() => {})
      return { ok: false, status: res.status, reason: `HTTP ${res.status}, not an SSE stream` }
    }

    const events = readSse(res.body, 4 * 1024 * 1024, this.stop.signal)
    const first = await withTimeout(events.next(), 10_000)
    if (!first || first.done || first.value.event !== 'endpoint') {
      this.stop.abort()
      return { ok: false, status: res.status, reason: 'stream opened, but no endpoint event' }
    }
    this.endpoint = new URL(first.value.data.trim(), this.url).toString()
    exchange.messages.push({ event: 'endpoint', data: first.value.data })
    void this.pump(events)
    return { ok: true, status: res.status }
  }

  private async pump(events: AsyncGenerator<{ event: string; data: string }>) {
    try {
      for await (const event of events) {
        if (this.closed) break
        const message = parseJson(event.data) as JsonRpcResponse | undefined
        if (!message || message.id === undefined || message.id === null) continue
        this.exchanges.get(message.id)?.messages.push(message)
        this.pending.get(message.id)?.(message)
      }
    } catch {
      // Stream ended or was cancelled.
    }
  }

  async send(body: Record<string, unknown>): Promise<PostResult> {
    if (!this.endpoint) throw new Error('SSE channel not open')
    const id = body.id as JsonRpcId | undefined
    const waiting = id === undefined ? undefined : new Promise<JsonRpcResponse | undefined>((resolve) => {
      this.pending.set(id, resolve)
      setTimeout(() => resolve(undefined), 15_000)
    })
    const posted = await this.wire.post(this.endpoint, body)
    if (id === undefined || !waiting) return posted
    this.exchanges.set(id, posted.exchange)
    const response = posted.response ?? (await waiting)
    this.pending.delete(id)
    return { exchange: posted.exchange, ...(response ? { response } : {}) }
  }

  close() {
    this.closed = true
    // Cancels the stream reader, which ends the pump and releases the GET connection.
    this.stop.abort()
    for (const resolve of this.pending.values()) resolve(undefined as unknown as JsonRpcResponse)
    this.pending.clear()
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))])
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isImplementation(value: unknown): value is Implementation {
  return isObject(value) && typeof value.name === 'string'
}
