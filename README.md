# MCP Check

Check, grade and explore any remote [Model Context Protocol](https://modelcontextprotocol.io) server, for free.
Paste a URL and get an A–F report on protocol compliance, tool quality, OAuth setup, security and speed.

Live at **[mcp.nischaldhakal.com.np](https://mcp.nischaldhakal.com.np)** (coming soon). Built by
[Nischal Dhakal](https://nischaldhakal.com.np).

## What it checks

| Area | Checks |
|---|---|
| Protocol | Which spec revision the server speaks (2026-07-28, 2025-xx Streamable HTTP, or the deprecated HTTP+SSE), server info, version negotiation, content types, notifications, `resultType`, unknown-method handling |
| Tools | Descriptions, valid input/output schemas, parameter descriptions, names, `readOnlyHint`/`destructiveHint`, size of the tool list in an agent's context, unknown-tool handling |
| Auth | The 401 challenge, protected resource metadata (RFC 9728), authorization server metadata and issuer, PKCE S256, client registration (Client ID Metadata Documents / DCR) |
| Security | HTTPS, Origin validation, stack traces or file paths leaking in errors |
| Speed | Time to connect and to list tools |

Every rule is traceable to the spec: see [docs/spec-notes.md](docs/spec-notes.md).

## How it works

- `src/mcp/`: an MCP client built for checking. It detects the server's era, records every message
  and timing, and enforces size and time limits.
- `src/checks/`: the graded rules. The same code runs in the Worker (online checks) and, later, the CLI
  (local and stdio servers), so grades match everywhere.
- `src/security/target.ts`: which URLs may be contacted. Online checks only reach public HTTPS hosts,
  including URLs a server hands back during OAuth discovery.
- `src/worker/`: the Cloudflare Worker API. `src/app/`: the Vue frontend.

## Develop

```bash
npm install
npm test             # unit tests against fake servers for every era
LIVE=1 npm test      # also check a few real public servers
npm run dev          # app + Worker locally
npm run build
```

## Roadmap

- [x] MCP client for all three eras, with auth discovery
- [x] Graded checks with fix advice
- [x] Checker interface, explorer (run tools), raw message log
- [x] Turnstile and abuse protection for the public API
- [ ] Shareable reports and README badges
- [ ] Public directory with server pages and nightly re-checks
- [ ] OAuth sign-in to inspect protected servers
- [ ] `npx mcp-check` CLI and GitHub Action
- [ ] Webhook and RSS alerts

## License

MIT
