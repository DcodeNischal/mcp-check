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

export const shareReport = (receipt: Receipt) =>
  post<{ ok: true; id: string; reportUrl: string; badgeUrl: string }>('/api/share', { receipt })

export async function getReport(id: string): Promise<Report | null> {
  const res = await fetch(`/api/report/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } })
  if (res.status === 404) return null
  const data = (await res.json().catch(() => null)) as { ok?: boolean; report?: Report } | null
  if (!res.ok || !data?.report) throw new ApiError('This report could not be loaded.', 'server')
  return data.report
}

export const callTool = (target: Target, tool: string, args: Record<string, unknown>, token: string) =>
  post<CallOutcome>('/api/call', { ...target, tool, arguments: args, token })
