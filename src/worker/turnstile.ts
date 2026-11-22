// Server-side Turnstile check. The token must be for the expected action and for one of our hostnames.
export interface TurnstileEnv {
  TURNSTILE_SECRET?: string
  TURNSTILE_HOSTNAMES?: string
}

export async function verifyTurnstile(token: unknown, ip: string | undefined, env: TurnstileEnv, action: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const hostnames = (env.TURNSTILE_HOSTNAMES ?? '').split(',').map((h) => h.trim()).filter(Boolean)
  if (!env.TURNSTILE_SECRET || hostnames.length === 0) return { ok: false, reason: 'not-configured' }
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return { ok: false, reason: 'missing-token' }
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { ok: false, reason: 'siteverify-http' }
    const outcome = (await res.json()) as { success?: boolean; action?: string; hostname?: string }
    if (outcome.success !== true) return { ok: false, reason: 'failed' }
    if (outcome.action !== action) return { ok: false, reason: 'action' }
    if (!hostnames.includes(outcome.hostname ?? '')) return { ok: false, reason: 'hostname' }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'siteverify-error' }
  }
}
