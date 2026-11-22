# MCP spec notes

The facts every check relies on, with the revision they come from. Source: modelcontextprotocol.io,
read November 2026. When the spec changes, update this file first, then the checks.

## Revisions

`2026-07-28` (current), `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`. A server may speak any of
these, so the client supports three eras:

| Era | Revisions | Shape |
|---|---|---|
| Modern | 2026-07-28 | Stateless. No `initialize`, no sessions. Every request carries `_meta` version + capabilities. |
| Legacy Streamable HTTP | 2025-11-25, 2025-06-18, 2025-03-26 | `initialize` → `notifications/initialized`, optional `Mcp-Session-Id`. |
| HTTP+SSE (deprecated) | 2024-11-05 | GET opens an SSE stream whose first event is `endpoint`; messages are POSTed there, responses arrive on the stream. |

## Modern requests (2026-07-28)

- One JSON-RPC message per POST. Headers:
  - `Accept: application/json, text/event-stream` (both required)
  - `MCP-Protocol-Version: 2026-07-28` (must equal `_meta["io.modelcontextprotocol/protocolVersion"]`, else 400 / -32020)
  - `Mcp-Method: <method>` on all requests
  - `Mcp-Name: <name>` on `tools/call`, `resources/read`, `prompts/get`
- `params._meta`:
  - `io.modelcontextprotocol/protocolVersion` (required)
  - `io.modelcontextprotocol/clientCapabilities` (required)
  - `io.modelcontextprotocol/clientInfo` (SHOULD)
- Responses: `application/json` (one object) or `text/event-stream` (progress/messages, then the response).
- Notifications get `202 Accepted`.
- Every result has `resultType`: `"complete"` or `"input_required"`. Treat a missing one as `"complete"` (older servers).
- `server/discover` (servers MUST implement): `supportedVersions`, `capabilities`, `instructions?`, `ttlMs`,
  `cacheScope`, `_meta["io.modelcontextprotocol/serverInfo"]` (SHOULD).
- Unsupported version: 400 with error `-32022`, `data: { supported: string[], requested: string }`.
- Error codes: `-32020` HeaderMismatch, `-32021` MissingRequiredClientCapability, `-32022` UnsupportedProtocolVersion.
  `-32000..-32019` implementation-defined; `-32020..-32099` reserved for MCP.
- Removed in 2026: sessions, GET stream, DELETE, `ping`, `Last-Event-ID`, `logging/setLevel`, `resources/subscribe`.
  GET/DELETE should return 405 on a modern-only server.
- Servers MUST validate `Origin` and return 403 if present and invalid.

## Detecting the era

1. POST a modern request (`server/discover`).
2. On 400/404/405: a recognised modern error body (-32020/-32021/-32022) means modern, so adjust and retry.
   Otherwise try the legacy `initialize`.
3. If `initialize` POST also fails with 4xx, GET the URL: an SSE stream whose first event is `endpoint`
   means the deprecated HTTP+SSE transport.

## Legacy lifecycle (2025-11-25)

- `initialize` params: `protocolVersion`, `capabilities`, `clientInfo` (`name`, `version`, …).
- Result: `protocolVersion`, `capabilities`, `serverInfo`, `instructions?`. The server answers with a version
  it supports if it doesn't support the requested one.
- Then `notifications/initialized`. Later requests send `MCP-Protocol-Version` (2025-06-18+) and
  `Mcp-Session-Id` if the server issued one. End with DELETE.

## Tools

- `tools/list` with `cursor` → `tools`, `nextCursor?` (2026 adds `ttlMs`, `cacheScope`). Order SHOULD be deterministic.
- Tool: `name`, `title?`, `description?`, `icons?`, `inputSchema` (JSON Schema, `type: "object"` at the root,
  2020-12 by default), `outputSchema?`, `annotations?`, `_meta?`.
- Names SHOULD be 1-128 chars of `A-Za-z0-9_-.`, case-sensitive, unique per server.
- No-parameter tools: `{ "type": "object", "additionalProperties": false }` recommended.
- `ToolAnnotations` (hints, untrusted from untrusted servers): `title?`, `readOnlyHint` (default false),
  `destructiveHint` (default true, meaningful only when not read-only), `idempotentHint` (default false),
  `openWorldHint` (default true).
- `tools/call` (`name`, `arguments`) → `content[]`, `structuredContent?`, `isError?`, `resultType`.
  Tool failures SHOULD be `isError: true` results; unknown tool is a protocol error (-32602).

## Authorization (2026-07-28)

1. Unauthenticated request → 401 with `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`.
2. Protected resource metadata (RFC 9728): from `resource_metadata`, else try
   `/.well-known/oauth-protected-resource/<path>` then `/.well-known/oauth-protected-resource`.
   MUST list `authorization_servers`.
3. Authorization server metadata, in order:
   - issuer with path `https://as/t1`: `/.well-known/oauth-authorization-server/t1`,
     `/.well-known/openid-configuration/t1`, `/t1/.well-known/openid-configuration`
   - issuer without path: `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration`
   - `issuer` in the document MUST equal the issuer used to build the URL.
4. PKCE: MUST. Clients MUST refuse if `code_challenge_methods_supported` is absent; use `S256`.
5. Client registration, in order: pre-registered → Client ID Metadata Document
   (`client_id_metadata_document_supported: true`; `client_id` is the HTTPS URL of a JSON doc with `client_id`,
   `client_name`, `redirect_uris`) → Dynamic Client Registration (`registration_endpoint`, deprecated) → ask the user.
6. `resource` parameter (RFC 8707) on authorization and token requests. Validate `iss` (RFC 9207) if present.
7. Tokens only in `Authorization: Bearer`, never in the query string. 403 + `error="insufficient_scope"` for scope.
