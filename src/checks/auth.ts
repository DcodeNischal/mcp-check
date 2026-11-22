// OAuth discovery for protected servers, in the order the 2026-07-28 spec requires.
// See docs/spec-notes.md, "Authorization".
import type { Wire } from '../mcp/wire'
import type { AuthSummary, CheckResult } from './types'

export type UrlGuard = (url: string) => boolean

export function parseChallenge(header: string | undefined): { scheme?: string; params: Record<string, string> } {
  if (!header) return { params: {} }
  const match = header.trim().match(/^(\S+)\s*(.*)$/)
  const scheme = match?.[1]
  const params: Record<string, string> = {}
  for (const m of (match?.[2] ?? '').matchAll(/([a-zA-Z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) {
    params[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1')
  }
  return { ...(scheme ? { scheme } : {}), params }
}

/** Protected resource metadata URLs, in spec order. */
export function resourceMetadataCandidates(mcpUrl: string, fromHeader?: string): string[] {
  if (fromHeader) return [fromHeader]
  const u = new URL(mcpUrl)
  const path = u.pathname.replace(/\/$/, '')
  return [
    ...(path ? [`${u.origin}/.well-known/oauth-protected-resource${path}`] : []),
    `${u.origin}/.well-known/oauth-protected-resource`,
  ]
}

/** Authorization server metadata URLs, in spec order. */
export function authServerCandidates(issuer: string): string[] {
  const u = new URL(issuer)
  const path = u.pathname.replace(/\/$/, '')
  if (!path) return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`]
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ]
}

export async function discoverAuth(wire: Wire, mcpUrl: string, challengeHeader: string | undefined, guard: UrlGuard): Promise<{ summary: AuthSummary; checks: CheckResult[] }> {
  const checks: CheckResult[] = []
  const summary: AuthSummary = { required: true, ...(challengeHeader ? { challenge: challengeHeader } : {}) }
  const challenge = parseChallenge(challengeHeader)

  // 1. The 401 challenge.
  if (challenge.scheme?.toLowerCase() === 'bearer' && challenge.params.resource_metadata) {
    checks.push(pass('auth.challenge', 'Auth challenge points to its metadata', 3, 'The 401 response includes a Bearer challenge with resource_metadata.'))
  } else if (challenge.scheme?.toLowerCase() === 'bearer') {
    checks.push(warn('auth.challenge', 'Auth challenge points to its metadata', 3,
      'The 401 response has a Bearer challenge but no resource_metadata, so clients must guess the metadata URL.',
      'Add resource_metadata="https://…/.well-known/oauth-protected-resource" to the WWW-Authenticate header.'))
  } else {
    checks.push(fail('auth.challenge', 'Auth challenge points to its metadata', 3,
      challengeHeader ? `The WWW-Authenticate header uses "${challenge.scheme}" instead of Bearer.` : 'The 401 response has no WWW-Authenticate header.',
      'Return WWW-Authenticate: Bearer resource_metadata="…" with every 401.'))
  }
  if (challenge.params.scope) summary.scopes = challenge.params.scope.split(/\s+/)

  // 2. Protected resource metadata (RFC 9728).
  let prm: Record<string, unknown> | undefined
  for (const candidate of resourceMetadataCandidates(mcpUrl, challenge.params.resource_metadata)) {
    if (!guard(candidate)) continue
    const got = await wire.getJson(candidate)
    if (got.status === 200 && got.json) {
      prm = got.json
      summary.resourceMetadataUrl = candidate
      break
    }
  }
  const servers = Array.isArray(prm?.authorization_servers) ? (prm!.authorization_servers as unknown[]).filter((s): s is string => typeof s === 'string') : []
  if (prm && servers.length) {
    summary.authorizationServers = servers
    if (!summary.scopes && Array.isArray(prm.scopes_supported)) summary.scopes = (prm.scopes_supported as unknown[]).filter((s): s is string => typeof s === 'string')
    checks.push(pass('auth.resource-metadata', 'Protected resource metadata', 3, `Found at ${summary.resourceMetadataUrl}, listing ${servers.length} authorization server${servers.length === 1 ? '' : 's'}.`))
  } else {
    checks.push(fail('auth.resource-metadata', 'Protected resource metadata', 3,
      prm ? 'The protected resource metadata has no authorization_servers.' : 'No protected resource metadata was found at the URL in the challenge or the well-known locations.',
      'Serve RFC 9728 metadata at /.well-known/oauth-protected-resource with an authorization_servers list.'))
    for (const [id, title] of [['auth.as-metadata', 'Authorization server metadata'], ['auth.pkce', 'PKCE with S256'], ['auth.registration', 'Client registration']] as const) {
      checks.push(skip(id, title, 'Skipped: no authorization server to inspect.'))
    }
    return { summary, checks }
  }

  // 3. Authorization server metadata, in the spec's URL order, with issuer verification.
  const issuer = servers[0]!
  let asMeta: Record<string, unknown> | undefined
  let mismatch: string | undefined
  for (const candidate of authServerCandidates(issuer)) {
    if (!guard(candidate)) continue
    const got = await wire.getJson(candidate)
    if (got.status !== 200 || !got.json) continue
    if (got.json.issuer !== issuer) {
      mismatch = String(got.json.issuer)
      continue
    }
    asMeta = got.json
    break
  }
  if (!asMeta) {
    checks.push(fail('auth.as-metadata', 'Authorization server metadata', 3,
      mismatch ? `The metadata's issuer (${mismatch}) does not match the authorization server (${issuer}), so clients must reject it.` : `No metadata found for ${issuer} at the RFC 8414 or OpenID Connect locations.`,
      'Serve /.well-known/oauth-authorization-server (or openid-configuration) whose "issuer" exactly matches the URL in authorization_servers.'))
    checks.push(skip('auth.pkce', 'PKCE with S256', 'Skipped: authorization server metadata not available.'))
    checks.push(skip('auth.registration', 'Client registration', 'Skipped: authorization server metadata not available.'))
    return { summary, checks }
  }
  summary.issuer = issuer
  if (typeof asMeta.authorization_endpoint === 'string') summary.authorizationEndpoint = asMeta.authorization_endpoint
  if (typeof asMeta.token_endpoint === 'string') summary.tokenEndpoint = asMeta.token_endpoint
  checks.push(pass('auth.as-metadata', 'Authorization server metadata', 3, `Found for ${issuer}, and its issuer matches.`))

  // 4. PKCE.
  const methods = Array.isArray(asMeta.code_challenge_methods_supported) ? (asMeta.code_challenge_methods_supported as unknown[]) : undefined
  summary.pkceS256 = !!methods?.includes('S256')
  checks.push(summary.pkceS256
    ? pass('auth.pkce', 'PKCE with S256', 3, 'The authorization server advertises S256.')
    : fail('auth.pkce', 'PKCE with S256', 3,
        methods ? `code_challenge_methods_supported lists ${methods.join(', ')}, but not S256.` : 'code_challenge_methods_supported is missing, so MCP clients must refuse to sign in.',
        'Support PKCE and add "code_challenge_methods_supported": ["S256"] to the metadata.'))

  // 5. Client registration.
  summary.clientIdMetadataDocuments = asMeta.client_id_metadata_document_supported === true
  summary.dynamicRegistration = typeof asMeta.registration_endpoint === 'string'
  if (summary.clientIdMetadataDocuments) {
    checks.push(pass('auth.registration', 'Client registration', 2, 'Supports Client ID Metadata Documents, so any client can sign in without registering first.'))
  } else if (summary.dynamicRegistration) {
    checks.push(warn('auth.registration', 'Client registration', 2, 'Supports Dynamic Client Registration only, which the 2026-07-28 spec deprecates.',
      'Add Client ID Metadata Document support ("client_id_metadata_document_supported": true).'))
  } else {
    checks.push(warn('auth.registration', 'Client registration', 2, 'No self-service registration: clients must be registered by hand before users can sign in.',
      'Support Client ID Metadata Documents so new MCP clients can connect without manual setup.'))
  }
  return { summary, checks }
}

const make = (status: CheckResult['status']) =>
  (id: string, title: string, weight: number, detail: string, fix?: string): CheckResult => ({ id, category: 'auth', title, status, weight, detail, ...(fix ? { fix } : {}) })
const pass = make('pass')
const warn = make('warn')
const fail = make('fail')
const skip = (id: string, title: string, detail: string): CheckResult => ({ id, category: 'auth', title, status: 'skip', weight: 0, detail })
