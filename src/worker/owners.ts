// Server owners prove they control a server's domain by serving a line of text at
// https://<domain>/.well-known/mcp-check.txt. "mcp-check: verify <id>" marks them as the verified
// owner (re-confirmed at every weekly re-check) and, if they had removed the server, lists it again;
// "mcp-check: remove <id>" takes the server out of the directory until they verify.
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

/**
 * Mark the owner as verified. A server its owner removed is listed again (unless its stored report
 * was made with credentials, which is never listed): only the domain's owner can undo a removal.
 * In the UPDATE, every expression reads the row as it was before it.
 */
export async function markVerified(db: D1Database, id: string): Promise<{ at: string; relisted: boolean }> {
  await ensureSchema(db)
  const at = new Date().toISOString()
  // One transaction: read the row as it was, then update it.
  const [before] = await db.batch<{ blocked: number; authenticated: number }>([
    db.prepare(`SELECT blocked, authenticated FROM servers WHERE id = ?1`).bind(id),
    db.prepare(`UPDATE servers SET owner_verified_at = ?2,
                  listed = CASE WHEN blocked = 1 AND authenticated = 0 THEN 1 ELSE listed END,
                  failures = CASE WHEN blocked = 1 THEN 0 ELSE failures END,
                  blocked = 0
                WHERE id = ?1`).bind(id, at),
  ])
  const row = before?.results?.[0]
  return { at, relisted: !!row && row.blocked === 1 && row.authenticated === 0 }
}

/** At a weekly re-check: keep the verified mark only while the proof is still served. */
export async function reconfirmOwner(db: D1Database, id: string, serverUrl: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const verified = await db.prepare(`SELECT owner_verified_at FROM servers WHERE id = ?1`).bind(id).first<string | null>('owner_verified_at')
  if (!verified) return
  if (!(await hasProof(serverUrl, id, 'verify', fetchImpl))) {
    await db.prepare(`UPDATE servers SET owner_verified_at = NULL WHERE id = ?1`).bind(id).run()
  }
}
