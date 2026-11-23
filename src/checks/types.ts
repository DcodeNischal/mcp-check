import type { DetectionStep } from '../mcp/client'
import type { Era, Implementation } from '../mcp/types'

export type Status = 'pass' | 'warn' | 'fail' | 'info' | 'skip'
export type Category = 'protocol' | 'tools' | 'auth' | 'security' | 'performance'
export type Grade = 'A' | 'B' | 'C' | 'D' | 'F'

export interface CheckResult {
  id: string
  category: Category
  title: string
  status: Status
  /** How much this check counts toward the score (info/skip don't count). */
  weight: number
  /** What we found, in plain words. */
  detail: string
  /** How to fix it, when it isn't a pass. */
  fix?: string
}

export interface ToolSummary {
  name: string
  title?: string
  description?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: Record<string, unknown>
}

export interface AuthSummary {
  required: boolean
  challenge?: string
  resourceMetadataUrl?: string
  authorizationServers?: string[]
  /** The resource identifier from the protected resource metadata (RFC 9728). */
  resource?: string
  issuer?: string
  authorizationEndpoint?: string
  tokenEndpoint?: string
  scopes?: string[]
  pkceS256?: boolean
  clientIdMetadataDocuments?: boolean
  dynamicRegistration?: boolean
  registrationEndpoint?: string
  /** The authorization server says who issued each response (RFC 9207 `iss`). */
  issParameterSupported?: boolean
}

export interface Report {
  url: string
  checkedAt: string
  durationMs: number
  connected: boolean
  /** True when credentials were supplied for this check (never the credentials themselves). */
  authenticated: boolean
  era?: Era
  version?: string
  serverInfo?: Implementation
  capabilities?: Record<string, unknown>
  instructions?: string
  steps: DetectionStep[]
  tools: ToolSummary[]
  prompts: { name: string; title?: string; description?: string }[]
  resources: { uri: string; name?: string; description?: string; mimeType?: string }[]
  resourceTemplates: { uriTemplate: string; name?: string; description?: string }[]
  auth?: AuthSummary
  checks: CheckResult[]
  /** True when only part of the server could be graded (sign-in needed to inspect tools). */
  partial?: boolean
  score: number
  grade: Grade
  /** The failed check that held an A down to a B, if one did. */
  gradeCap?: string
  /** Which version of the grading rules produced this grade (missing means 1). */
  gradingVersion?: number
  error?: string
}
