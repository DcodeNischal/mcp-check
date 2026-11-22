import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { authorizeUrl, clientMetadata, discoverSignIn, parseRegistration, parseTokenResponse, pkceChallenge, SignInError, tokenRequest } from '../src/worker/oauth'
import { asFetch, protectedServer } from './fixtures/servers'

const ORIGIN = 'https://mcp.nischaldhakal.com.np'

describe('OAuth sign-in', () => {
  it('discovers what it needs from a protected server', async () => {
    const auth = await discoverSignIn('https://mcp.example.com/mcp', asFetch(protectedServer({ dcr: true })))
    expect(auth).toMatchObject({
      issuer: 'https://auth.example.com',
      authorizationEndpoint: 'https://auth.example.com/authorize',
      tokenEndpoint: 'https://auth.example.com/token',
      registrationEndpoint: 'https://auth.example.com/register',
      resource: 'https://mcp.example.com/mcp',
      scopes: ['read'],
      pkceS256: true,
      clientIdMetadataDocuments: true,
    })
  })

  it('refuses servers it must not or cannot sign in to', async () => {
    await expect(discoverSignIn('https://mcp.example.com/mcp', asFetch(protectedServer({ pkce: false })))).rejects.toThrow(/PKCE/)
    await expect(discoverSignIn('https://mcp.example.com/mcp', asFetch(protectedServer({ issuerMismatch: true })))).rejects.toThrow(SignInError)
    const open = asFetch(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { headers: { 'content-type': 'application/json' } }))
    await expect(discoverSignIn('https://open.example.com/mcp', open)).rejects.toThrow(/doesn't ask for sign-in/)
  })

  it('builds the authorization URL with PKCE, state and resource', async () => {
    const challenge = await pkceChallenge('verifier-123')
    expect(challenge).toBe(createHash('sha256').update('verifier-123').digest('base64url'))
    const u = new URL(authorizeUrl(
      { required: true, authorizationEndpoint: 'https://auth.example.com/authorize?tenant=x', scopes: ['read', 'write'] },
      { clientId: `${ORIGIN}/oauth/client.json`, authMethod: 'none' },
      { redirectUri: `${ORIGIN}/oauth/callback`, state: 's1', challenge, resource: 'https://mcp.example.com/mcp' },
    ))
    expect(Object.fromEntries(u.searchParams)).toEqual({
      tenant: 'x',
      response_type: 'code',
      client_id: `${ORIGIN}/oauth/client.json`,
      redirect_uri: `${ORIGIN}/oauth/callback`,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's1',
      resource: 'https://mcp.example.com/mcp',
      scope: 'read write',
    })
  })

  it('describes itself as a public client', () => {
    expect(clientMetadata(ORIGIN)).toEqual({
      client_id: `${ORIGIN}/oauth/client.json`,
      client_name: 'MCP Check',
      client_uri: ORIGIN,
      redirect_uris: [`${ORIGIN}/oauth/callback`],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    })
  })

  it('reads registrations and authenticates token requests to match', () => {
    expect(parseRegistration({ client_id: 'pub' })).toEqual({ clientId: 'pub', authMethod: 'none' })
    expect(parseRegistration({ client_id: 'c', client_secret: 's', token_endpoint_auth_method: 'client_secret_post' })).toEqual({ clientId: 'c', clientSecret: 's', authMethod: 'client_secret_post' })
    expect(parseRegistration({ client_id: 'c', client_secret: 's' }).authMethod).toBe('client_secret_basic')

    const base = { client_id: 'c id', client_secret: 's:1', redirect_uri: `${ORIGIN}/oauth/callback`, verifier: 'v', resource: 'https://mcp.example.com/mcp' }
    const pub = tokenRequest({ ...base, client_secret: null, auth_method: 'none' }, 'code1')
    expect(Object.fromEntries(pub.body)).toEqual({ grant_type: 'authorization_code', code: 'code1', redirect_uri: base.redirect_uri, code_verifier: 'v', resource: base.resource, client_id: 'c id' })
    expect(pub.headers.Authorization).toBeUndefined()

    const basic = tokenRequest({ ...base, auth_method: 'client_secret_basic' }, 'code1')
    expect(basic.headers.Authorization).toBe(`Basic ${btoa('c+id:s%3A1')}`)
    expect(basic.body.has('client_id')).toBe(false)

    const post = tokenRequest({ ...base, auth_method: 'client_secret_post' }, 'code1')
    expect(post.body.get('client_secret')).toBe('s:1')
  })

  it('accepts only bearer tokens and explains failures', () => {
    expect(parseTokenResponse(200, { access_token: 't', token_type: 'Bearer', expires_in: 3600, scope: 'read' })).toEqual({ accessToken: 't', expiresIn: 3600, scope: 'read' })
    expect(() => parseTokenResponse(200, { access_token: 't', token_type: 'mac' })).toThrow(/Bearer/)
    expect(() => parseTokenResponse(400, { error: 'invalid_grant', error_description: 'Code expired' })).toThrow(/Code expired/)
    expect(() => parseTokenResponse(200, {})).toThrow(/without an access token/)
  })
})
