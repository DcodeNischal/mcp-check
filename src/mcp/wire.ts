// HTTP layer: sends JSON-RPC messages, reads JSON or SSE responses, enforces time and size
// limits, and records every exchange for the raw log and the checks.
import { readSse, SizeLimitError } from './sse'
import type { Exchange, JsonRpcId, JsonRpcResponse } from './types'

export interface WireOptions {
  fetch?: typeof fetch
  /** Per-request time limit. */
  timeoutMs?: number
  /** Per-response size limit. */
  maxBytes?: number
  /** Sent on every request (auth, custom headers). Never recorded in the log. */
  headers?: Record<string, string>
}

export interface PostResult {
  exchange: Exchange
  /** The JSON-RPC response matching the request id, if one arrived. */
  response?: JsonRpcResponse
}

/** Sent on every request so server owners can see who is calling and where to learn more. */
export const USER_AGENT = 'MCP-Check/0.1 (+https://mcp.nischaldhakal.com.np)'

const DEFAULT_TIMEOUT = 15_000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const RAW_TEXT_LIMIT = 4_000

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export class Wire {
  readonly log: Exchange[] = []
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly maxBytes: number
  private readonly baseHeaders: Record<string, string>

  constructor(opts: WireOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init))
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
    this.baseHeaders = { 'User-Agent': USER_AGENT, ...(opts.headers ?? {}) }
  }

  /** POST one JSON-RPC message. For requests, reads until the response with the same id arrives. */
  async post(url: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<PostResult> {
    const id = body.id as JsonRpcId | undefined
    const exchange = this.start('POST', url, body)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const t0 = now()
    try {
      const res = await untilAborted(
        this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...this.baseHeaders,
            ...headers,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: 'manual',
        }),
        controller.signal,
      )
      this.record(exchange, res)
      const response = await untilAborted(this.readMessages(exchange, res, id), controller.signal)
      return { exchange, ...(response ? { response } : {}) }
    } catch (err) {
      exchange.error = describe(err, controller.signal.aborted, this.timeoutMs)
      return { exchange }
    } finally {
      clearTimeout(timer)
      exchange.ms = Math.round(now() - t0)
    }
  }

  /** A plain request (GET/DELETE) whose body we only peek at. */
  async request(method: 'GET' | 'DELETE', url: string, headers: Record<string, string> = {}): Promise<{ exchange: Exchange; res?: Response }> {
    const exchange = this.start(method, url)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const t0 = now()
    try {
      const res = await untilAborted(
        this.fetchImpl(url, {
          method,
          headers: { ...this.baseHeaders, ...headers },
          signal: controller.signal,
          redirect: 'manual',
        }),
        controller.signal,
      )
      this.record(exchange, res)
      return { exchange, res }
    } catch (err) {
      exchange.error = describe(err, controller.signal.aborted, this.timeoutMs)
      return { exchange }
    } finally {
      clearTimeout(timer)
      exchange.ms = Math.round(now() - t0)
    }
  }

  /** Fetch a JSON document (OAuth metadata). Not part of the MCP log. */
  async getJson(url: string): Promise<{ status?: number; json?: Record<string, unknown>; error?: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await untilAborted(this.fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal: controller.signal, redirect: 'manual' }), controller.signal)
      const text = await untilAborted(readText(res, 256 * 1024), controller.signal)
      try {
        const json = JSON.parse(text)
        return { status: res.status, ...(json && typeof json === 'object' && !Array.isArray(json) ? { json } : {}) }
      } catch {
        return { status: res.status }
      }
    } catch (err) {
      return { error: describe(err, controller.signal.aborted, this.timeoutMs) }
    } finally {
      clearTimeout(timer)
    }
  }

  private start(method: Exchange['method'], url: string, body?: Record<string, unknown>): Exchange {
    const exchange: Exchange = {
      at: Date.now(),
      method,
      url,
      responseHeaders: {},
      messages: [],
      ms: 0,
      ...(body ? { requestBody: body, rpcMethod: typeof body.method === 'string' ? body.method : undefined } : {}),
    }
    this.log.push(exchange)
    return exchange
  }

  private record(exchange: Exchange, res: Response) {
    exchange.status = res.status
    exchange.contentType = res.headers.get('content-type') ?? undefined
    res.headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'set-cookie') exchange.responseHeaders[key.toLowerCase()] = value
    })
  }

  private async readMessages(exchange: Exchange, res: Response, id: JsonRpcId | undefined): Promise<JsonRpcResponse | undefined> {
    const type = (res.headers.get('content-type') ?? '').toLowerCase()
    if (!res.body || res.status === 202 || res.status === 204) return undefined

    if (type.includes('text/event-stream')) {
      for await (const event of readSse(res.body, this.maxBytes)) {
        const message = parseJson(event.data)
        if (message === undefined) continue
        exchange.messages.push(message)
        if (isResponseTo(message, id)) return message as JsonRpcResponse
      }
      return undefined
    }

    const text = await readText(res, this.maxBytes)
    const message = parseJson(text)
    if (message === undefined) {
      if (text) exchange.rawText = text.slice(0, RAW_TEXT_LIMIT)
      return undefined
    }
    exchange.messages.push(message)
    return isResponseTo(message, id) ? (message as JsonRpcResponse) : undefined
  }
}

export function isResponseTo(message: unknown, id: JsonRpcId | undefined): boolean {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false
  const m = message as Record<string, unknown>
  if (!('result' in m) && !('error' in m)) return false
  // An error with id null answers a request the server couldn't parse.
  return id === undefined || m.id === id || (m.id === null && 'error' in m)
}

export function parseJson(text: string): unknown {
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export async function readText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let total = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new SizeLimitError(maxBytes)
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.cancel().catch(() => {})
  }
}

/** Rejects as soon as the signal aborts, even if the underlying promise ignores the signal. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

function describe(err: unknown, aborted: boolean, timeoutMs: number): string {
  if (aborted) return `Timed out after ${Math.round(timeoutMs / 1000)}s`
  if (err instanceof SizeLimitError) return err.message
  return err instanceof Error ? err.message : String(err)
}
