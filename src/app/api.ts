import type { CallOutcome } from '../checks/call'
import type { Report } from '../checks/types'
import type { Exchange } from '../mcp/types'

export type { Report, Exchange, CallOutcome }

export class ApiError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
  } catch {
    throw new ApiError('Network error. Check your connection and try again.', 'network')
  }
  const data = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string; message?: string }) | null
  if (!data) throw new ApiError(`The checker returned an unexpected response (HTTP ${res.status}).`, 'server')
  // /api/call answers 200 even when the tool itself fails (its log is still useful), so only
  // non-2xx responses are errors here.
  if (!res.ok) throw new ApiError(data.message ?? 'Something went wrong.', data.error ?? 'server')
  return data
}

export interface Target {
  url: string
  headers: Record<string, string>
}

export interface Receipt {
  payload: string
  sig: string
}

export const checkServer = (target: Target, token: string) =>
  post<{ ok: true; report: Report; log: Exchange[]; receipt?: Receipt }>('/api/check', { ...target, token })

/** Start an OAuth sign-in: the browser should go to the returned URL. */
export const startSignIn = (url: string, token: string) => post<{ ok: true; authorizeUrl: string }>('/api/oauth/start', { url, token })

/** After the sign-in comes back: fetch the access token, once. */
export const claimSignIn = () => post<{ ok: true; url: string; accessToken: string; expiresIn?: number; scope?: string }>('/api/oauth/claim', {})

export const shareReport = (receipt: Receipt, list: boolean) =>
  post<{ ok: true; id: string; reportUrl: string; badgeUrl: string; listed: boolean; blocked: boolean }>('/api/share', { receipt, list })

export interface RegistryInfo {
  name: string
  description: string | null
  repositoryUrl: string | null
  websiteUrl: string | null
}

export interface StoredReport {
  report: Report
  listed: boolean
  blocked: boolean
  /** When the owner last proved control of the domain, if they have. */
  verifiedAt?: string
  registry?: RegistryInfo
}

export async function getReport(id: string): Promise<StoredReport | null> {
  const res = await fetch(`/api/report/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } })
  if (res.status === 404) return null
  const data = (await res.json().catch(() => null)) as ({ ok?: boolean } & Partial<StoredReport>) | null
  if (!res.ok || !data?.report) throw new ApiError('This report could not be loaded.', 'server')
  return { report: data.report, listed: !!data.listed, blocked: !!data.blocked, ...(data.verifiedAt ? { verifiedAt: data.verifiedAt } : {}), ...(data.registry ? { registry: data.registry } : {}) }
}

export interface DirectoryEntry {
  id: string
  url: string
  name: string | null
  grade: string
  score: number
  tools_count: number
  spec_version: string | null
  era: string | null
  partial: number
  auth_required: number
  checked_at: string
  description: string | null
  owner_verified_at?: string | null
  /** Why a search result matched, when it isn't obvious from the name or description. */
  match?: string
}

export async function listServers(params: { q?: string; grade?: string; sort?: string; page?: number }) {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v))
  // Skip the browser's cache: Cloudflare's zone settings can stretch it to hours, which hid new grades
  // and verified marks. The API's own edge cache still answers repeat requests for a minute.
  const res = await fetch(`/api/servers?${qs}`, { headers: { Accept: 'application/json' }, cache: 'no-store' })
  const data = (await res.json().catch(() => null)) as { servers?: DirectoryEntry[]; total?: number; pageSize?: number } | null
  if (!res.ok || !data?.servers) throw new ApiError('The directory could not be loaded.', 'server')
  return { servers: data.servers, total: data.total ?? 0, pageSize: data.pageSize ?? 30 }
}

export const subscribeWebhook = (id: string, url: string, token: string) =>
  post<{ ok: true; id: string; secret: string; format: 'json' | 'slack' | 'discord' }>('/api/webhooks', { id, url, token })

export const verifyOwner = (id: string) => post<{ ok: true; verifiedAt: string; relisted: boolean; message: string }>('/api/verify', { id })

export const unlistServer = (id: string) => post<{ ok: true; message: string }>('/api/unlist', { id })

export const callTool = (target: Target, tool: string, args: Record<string, unknown>, token: string) =>
  post<CallOutcome>('/api/call', { ...target, tool, arguments: args, token })
