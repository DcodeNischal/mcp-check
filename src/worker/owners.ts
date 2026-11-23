// Server owners prove they control a server's domain by serving a line of text at
// https://<domain>/.well-known/mcp-check.txt. "mcp-check: verify <id>" marks them as the verified
// owner (re-confirmed at every weekly re-check); "mcp-check: remove <id>" takes the server out of
// the directory for good.
import { USER_AGENT } from '../mcp/wire'
import { checkTarget } from '../security/target'
import { ensureSchema } from './store'

export type ProofAction = 'verify' | 'remove'

export function proofUrl(serverUrl: string): string {
  return `${new URL(serverUrl).origin}/.well-known/mcp-check.txt`
}

/** Does the server's domain currently serve "mcp-check: <action> <id>"? */
export async function hasProof(serverUrl: string, id: string, action: ProofAction, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const url = proofUrl(serverUrl)
  if (!checkTarget(url).ok) return false
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    const text = res.ok ? (await res.text()).slice(0, 4096) : ''
    return proofMatches(text, id, action)
  } catch {
    return false
  }
}

export function proofMatches(text: string, id: string, action: ProofAction): boolean {
  return new RegExp(`(^|\\n)\\s*mcp-check:\\s*${action}\\s+${id}\\b`, 'i').test(text)
}

export async function markVerified(db: D1Database, id: string): Promise<string> {
  await ensureSchema(db)
  const at = new Date().toISOString()
  await db.prepare(`UPDATE servers SET owner_verified_at = ?2 WHERE id = ?1`).bind(id, at).run()
  return at
}

/** At a weekly re-check: keep the verified mark only while the proof is still served. */
export async function reconfirmOwner(db: D1Database, id: string, serverUrl: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const verified = await db.prepare(`SELECT owner_verified_at FROM servers WHERE id = ?1`).bind(id).first<string | null>('owner_verified_at')
  if (!verified) return
  if (!(await hasProof(serverUrl, id, 'verify', fetchImpl))) {
    await db.prepare(`UPDATE servers SET owner_verified_at = NULL WHERE id = ?1`).bind(id).run()
  }
}
