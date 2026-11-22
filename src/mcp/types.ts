// Shapes shared by the client and the checks. See docs/spec-notes.md.

export const MODERN_VERSION = '2026-07-28'
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const
export const SSE_VERSION = '2024-11-05'
export const ALL_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS, SSE_VERSION]

export type Era = 'modern' | 'legacy-streamable' | 'legacy-sse'

export const META = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
} as const

export const ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  headerMismatch: -32020,
  missingCapability: -32021,
  unsupportedVersion: -32022,
} as const

export type JsonRpcId = number | string

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  result?: Record<string, unknown>
  error?: JsonRpcError
}

export interface Implementation {
  name: string
  version?: string
  title?: string
  description?: string
  websiteUrl?: string
}

export interface ToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface Tool {
  name: string
  title?: string
  description?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: ToolAnnotations
}

export interface Prompt {
  name: string
  title?: string
  description?: string
  arguments?: { name: string; description?: string; required?: boolean }[]
}

export interface Resource {
  uri: string
  name?: string
  title?: string
  description?: string
  mimeType?: string
}

export interface ResourceTemplate {
  uriTemplate: string
  name?: string
  title?: string
  description?: string
  mimeType?: string
}

/** One HTTP exchange, kept for the raw log and for checks that look at headers and timing. */
export interface Exchange {
  at: number
  method: 'GET' | 'POST' | 'DELETE'
  url: string
  /** JSON-RPC method, if this was a JSON-RPC message. */
  rpcMethod?: string
  requestBody?: unknown
  status?: number
  contentType?: string
  responseHeaders: Record<string, string>
  /** Parsed JSON-RPC messages received (one for JSON, possibly several for SSE). */
  messages: unknown[]
  /** Raw text when the body wasn't valid JSON or SSE (truncated). */
  rawText?: string
  ms: number
  error?: string
}
