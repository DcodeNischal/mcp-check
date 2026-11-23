// Sign in to a protected MCP server with OAuth (authorization code + PKCE), so its tools can be
// checked and explored. MCP Check is a public client: it identifies itself with a Client ID
// Metadata Document where the authorization server supports one, and falls back to Dynamic Client
// Registration. The access token is handed to the visitor's browser once and never kept.
import { discoverAuth } from '../checks/auth'
import type { AuthSummary } from '../checks/types'
import { CLIENT_INFO } from '../mcp/client'
import { LEGACY_VERSIONS } from '../mcp/types'
import { USER_AGENT, Wire } from '../mcp/wire'
import { checkTarget } from '../security/target'
import { ensureSchema } from './store'

export const CLIENT_METADATA_PATH = '/oauth/client.json'
export const CALLBACK_PATH = '/oauth/callback'
export const COOKIE = 'mcpc_signin'
/** How long a sign-in may take, from start to claiming the token. */
export const PENDING_TTL_S = 600

const isPublicHttps = (url: string) => checkTarget(url).ok

/** Who MCP Check is, as an OAuth client. Served at CLIENT_METADATA_PATH and sent when registering. */
export function clientMetadata(origin: string) {
  return {
    client_id: `${origin}${CLIENT_METADATA_PATH}`,
    client_name: 'MCP Check',
    client_uri: origin,
    redirect_uris: [`${origin}${CALLBACK_PATH}`],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)))
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}

export class SignInError extends Error {}

// --- discovery -------------------------------------------------------------------------------

/** Ask the server for its auth requirements: it must answer 401 with a usable OAuth setup. */
export async function discoverSignIn(url: string, fetchImpl?: typeof fetch): Promise<AuthSummary> {
  const wire = new Wire({ timeoutMs: 10_000, ...(fetchImpl ? { fetch: fetchImpl } : {}) })
  const { exchange } = await wire.post(url, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: LEGACY_VERSIONS[0], capabilities: {}, clientInfo: CLIENT_INFO },
  })
  if (exchange.error) throw new SignInError(`The server couldn't be reached: ${exchange.error}`)
  if (exchange.status !== 401) throw new SignInError("This server doesn't ask for sign-in, so you can check it without signing in.")
  const { summary } = await discoverAuth(wire, url, exchange.responseHeaders['www-authenticate'], isPublicHttps)
  if (!summary.authorizationEndpoint || !summary.tokenEndpoint || !summary.issuer) {
    throw new SignInError("This server's sign-in setup couldn't be found. Run a check to see which part is missing.")
  }
  if (!summary.pkceS256) throw new SignInError("This server's sign-in doesn't support PKCE (S256), which MCP requires, so MCP Check won't sign in.")
  if (!/^https:\/\//i.test(summary.authorizationEndpoint) || !isPublicHttps(summary.tokenEndpoint)) {
    throw new SignInError("This server's sign-in endpoints must be public https URLs.")
  }
  // The token must be for this server: a server can't send visitors to sign in for another one.
  if (summary.resource && !resourceCovers(summary.resource, url)) {
    throw new SignInError(`This server's metadata asks for a sign-in to ${summary.resource}, not to this server, so MCP Check won't sign in.`)
  }
  // Mix-up protection: endpoints on another origin than the issuer are only trusted if the
  // authorization server confirms who answered (iss), so a fake issuer can't borrow a real
  // server's sign-in page and collect the code.
  if (!sameOriginEndpoints(summary) && !summary.issParameterSupported) {
    throw new SignInError("This server's sign-in pages aren't on its authorization server's own address, and it doesn't confirm who answers, so MCP Check won't sign in.")
  }
  return summary
}

/** Does the protected resource identifier cover the checked URL (same origin, path prefix)? */
export function resourceCovers(resource: string, url: string): boolean {
  try {
    const r = new URL(resource)
    const u = new URL(url)
    const path = r.pathname.replace(/\/$/, '')
    return r.origin === u.origin && (u.pathname === path || u.pathname.startsWith(`${path}/`) || path === '')
  } catch {
    return false
  }
}

/** Are the authorization and token endpoints on the issuer's own origin? */
export function sameOriginEndpoints(auth: Pick<AuthSummary, 'issuer' | 'authorizationEndpoint' | 'tokenEndpoint'>): boolean {
  try {
    const origin = new URL(auth.issuer!).origin
    return new URL(auth.authorizationEndpoint!).origin === origin && new URL(auth.tokenEndpoint!).origin === origin
  } catch {
    return false
  }
}

// --- client registration ---------------------------------------------------------------------

export interface Client {
  clientId: string
  clientSecret?: string
  authMethod: 'none' | 'client_secret_basic' | 'client_secret_post'
}

/** A client id for this authorization server: the metadata document URL, or a (cached) registration. */
export async function clientFor(db: D1Database, auth: AuthSummary, origin: string, fetchImpl: typeof fetch = fetch): Promise<Client> {
  const metadata = clientMetadata(origin)
  // The authorization server must be able to fetch the document, so not from a local dev server.
  if (auth.clientIdMetadataDocuments && isPublicHttps(metadata.client_id)) return { clientId: metadata.client_id, authMethod: 'none' }

  if (!auth.registrationEndpoint || !isPublicHttps(auth.registrationEndpoint)) {
    throw new SignInError("This server's sign-in only works with apps registered by hand, so MCP Check can't sign in. Paste a token instead.")
  }
  const redirect = metadata.redirect_uris[0]!
  const cached = await db
    .prepare(`SELECT client_id, client_secret, auth_method FROM oauth_clients WHERE issuer = ?1 AND redirect_uri = ?2`)
    .bind(auth.issuer, redirect)
    .first<{ client_id: string; client_secret: string | null; auth_method: Client['authMethod'] }>()
  if (cached) return { clientId: cached.client_id, ...(cached.client_secret ? { clientSecret: cached.client_secret } : {}), authMethod: cached.auth_method }

  const { client_id: _id, ...registration } = metadata
  const res = await fetchImpl(auth.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify(registration),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  const data = (await res?.json().catch(() => null)) as Record<string, unknown> | null
  if (!res?.ok || typeof data?.client_id !== 'string') {
    throw new SignInError(`Registering MCP Check with this server's sign-in failed${res ? ` (HTTP ${res.status})` : ''}.`)
  }
  const client = parseRegistration(data)
  await db
    .prepare(`INSERT INTO oauth_clients (issuer, redirect_uri, client_id, client_secret, auth_method, registered_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
              ON CONFLICT (issuer, redirect_uri) DO UPDATE SET client_id = ?3, client_secret = ?4, auth_method = ?5, registered_at = ?6`)
    .bind(auth.issuer, redirect, client.clientId, client.clientSecret ?? null, client.authMethod, new Date().toISOString())
    .run()
  return client
}

export function parseRegistration(data: Record<string, unknown>): Client {
  const secret = typeof data.client_secret === 'string' && data.client_secret ? data.client_secret : undefined
  const method = data.token_endpoint_auth_method
  const authMethod: Client['authMethod'] = !secret ? 'none' : method === 'client_secret_post' ? 'client_secret_post' : 'client_secret_basic'
  return { clientId: String(data.client_id), ...(secret ? { clientSecret: secret } : {}), authMethod }
}

// --- the flow --------------------------------------------------------------------------------

export function authorizeUrl(auth: AuthSummary, client: Client, p: { redirectUri: string; state: string; challenge: string; resource: string }): string {
  const u = new URL(auth.authorizationEndpoint!)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', client.clientId)
  u.searchParams.set('redirect_uri', p.redirectUri)
  u.searchParams.set('code_challenge', p.challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('state', p.state)
  // RFC 8707: the token is for this MCP server only.
  u.searchParams.set('resource', p.resource)
  if (auth.scopes?.length) u.searchParams.set('scope', auth.scopes.join(' '))
  return u.toString()
}

/** Start a sign-in: returns the URL to send the visitor to, and the state that ties it to them. */
export async function startSignIn(db: D1Database, url: string, origin: string, fetchImpl?: typeof fetch): Promise<{ authorizeUrl: string; state: string }> {
  await ensureSchema(db)
  const auth = await discoverSignIn(url, fetchImpl)
  const client = await clientFor(db, auth, origin, fetchImpl)
  const state = randomToken()
  const verifier = randomToken()
  const redirectUri = `${origin}${CALLBACK_PATH}`
  const resource = auth.resource ?? url
  await db.batch([
    db.prepare(`DELETE FROM oauth_pending WHERE created_at < ?1`).bind(Date.now() - PENDING_TTL_S * 1000),
    db.prepare(`INSERT INTO oauth_pending (state, server_url, issuer, token_endpoint, client_id, client_secret, auth_method, redirect_uri, verifier, resource, created_at, require_iss)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`)
      .bind(state, url, auth.issuer, auth.tokenEndpoint, client.clientId, client.clientSecret ?? null, client.authMethod, redirectUri, verifier, resource, Date.now(), sameOriginEndpoints(auth) ? 0 : 1),
  ])
  return { authorizeUrl: authorizeUrl(auth, client, { redirectUri, state, challenge: await pkceChallenge(verifier), resource }), state }
}

interface Pending {
  state: string
  server_url: string
  issuer: string
  token_endpoint: string
  client_id: string
  client_secret: string | null
  auth_method: Client['authMethod']
  redirect_uri: string
  verifier: string
  resource: string
  created_at: number
  require_iss: number
}

async function loadPending(db: D1Database, state: string): Promise<Pending | undefined> {
  await ensureSchema(db)
  const row = await db.prepare(`SELECT * FROM oauth_pending WHERE state = ?1`).bind(state).first<Pending>()
  return row && Date.now() - row.created_at <= PENDING_TTL_S * 1000 ? row : undefined
}

/** The token request for an authorization code. */
export function tokenRequest(p: Pick<Pending, 'client_id' | 'client_secret' | 'auth_method' | 'redirect_uri' | 'verifier' | 'resource'>, code: string): { headers: Record<string, string>; body: URLSearchParams } {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: p.redirect_uri, code_verifier: p.verifier, resource: p.resource })
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': USER_AGENT }
  if (p.auth_method === 'client_secret_basic' && p.client_secret) {
    const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+')
    headers.Authorization = `Basic ${btoa(`${enc(p.client_id)}:${enc(p.client_secret)}`)}`
  } else {
    body.set('client_id', p.client_id)
    if (p.auth_method === 'client_secret_post' && p.client_secret) body.set('client_secret', p.client_secret)
  }
  return { headers, body }
}

export function parseTokenResponse(status: number, data: Record<string, unknown> | null): { accessToken: string; expiresIn?: number; scope?: string } {
  if (status !== 200 || !data) {
    const why = typeof data?.error_description === 'string' ? data.error_description : typeof data?.error === 'string' ? data.error : `HTTP ${status}`
    throw new SignInError(`The server's sign-in didn't issue a token: ${why.slice(0, 200)}`)
  }
  if (typeof data.access_token !== 'string' || !data.access_token) throw new SignInError("The server's sign-in answered without an access token.")
  if (typeof data.token_type === 'string' && data.token_type.toLowerCase() !== 'bearer') {
    throw new SignInError(`The server issued a "${data.token_type}" token, but MCP uses Bearer tokens.`)
  }
  return {
    accessToken: data.access_token,
    ...(typeof data.expires_in === 'number' ? { expiresIn: data.expires_in } : {}),
    ...(typeof data.scope === 'string' ? { scope: data.scope } : {}),
  }
}

/**
 * The authorization server sent the visitor back. Exchange the code for a token and keep it on
 * the pending row until the page claims it. Returns the server URL to go back to.
 */
export async function finishSignIn(db: D1Database, state: string, query: URLSearchParams, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const pending = await loadPending(db, state)
  if (!pending) return undefined
  const fail = async (message: string) => {
    await db.prepare(`UPDATE oauth_pending SET error = ?2 WHERE state = ?1`).bind(state, message.slice(0, 300)).run()
    return pending.server_url
  }
  const error = query.get('error')
  if (error) return fail(error === 'access_denied' ? 'Sign-in was cancelled.' : `The server's sign-in returned an error: ${(query.get('error_description') ?? error).slice(0, 200)}`)
  // RFC 9207: if the server says who issued the response, it must be the server we started with.
  const iss = query.get('iss')
  if (iss && iss !== pending.issuer) return fail('The sign-in response came from a different authorization server, so it was rejected.')
  if (!iss && pending.require_iss) return fail("The authorization server didn't confirm it issued this response, so it was rejected.")
  const code = query.get('code')
  if (!code) return fail("The server's sign-in didn't return a code.")
  if (!isPublicHttps(pending.token_endpoint)) return fail("The server's token endpoint isn't a public https URL.")

  try {
    const { headers, body } = tokenRequest(pending, code)
    const res = await fetchImpl(pending.token_endpoint, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
    const token = parseTokenResponse(res.status, data)
    await db
      .prepare(`UPDATE oauth_pending SET access_token = ?2, expires_in = ?3, scope = ?4, verifier = '' WHERE state = ?1`)
      .bind(state, token.accessToken, token.expiresIn ?? null, token.scope ?? null)
      .run()
    return pending.server_url
  } catch (err) {
    return fail(err instanceof SignInError ? err.message : "The server's token endpoint couldn't be reached.")
  }
}

/** Forget sign-ins that were never finished or claimed (and any token they hold). */
export async function purgeExpiredSignIns(db: D1Database): Promise<void> {
  await db.prepare(`DELETE FROM oauth_pending WHERE created_at < ?1`).bind(Date.now() - PENDING_TTL_S * 1000).run()
}

/** Hand the token to the page that started the sign-in, once. */
export async function claimSignIn(db: D1Database, state: string): Promise<{ ok: true; url: string; accessToken: string; expiresIn?: number; scope?: string } | { ok: false; message: string }> {
  const pending = (await loadPending(db, state)) as (Pending & { access_token: string | null; expires_in: number | null; scope: string | null; error: string | null }) | undefined
  if (!pending) return { ok: false, message: 'This sign-in expired. Please sign in again.' }
  await db.prepare(`DELETE FROM oauth_pending WHERE state = ?1`).bind(state).run()
  if (pending.error || !pending.access_token) return { ok: false, message: pending.error ?? 'Sign-in was not completed.' }
  return {
    ok: true,
    url: pending.server_url,
    accessToken: pending.access_token,
    ...(pending.expires_in ? { expiresIn: pending.expires_in } : {}),
    ...(pending.scope ? { scope: pending.scope } : {}),
  }
}
