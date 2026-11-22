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

## Directory

Shared reports can be listed at `/servers`. Reports made with credentials are never listed. A scheduled
job re-checks one listed server every 10 minutes once its report is a week old; three failed re-checks in
a row unlist it. Owners can remove their server by serving `mcp-check: remove <id>` at
`https://<their-domain>/.well-known/mcp-check.txt` and pressing "Verify and remove" on its report page;
it can't be listed again after that.

## Registry import

A cron trigger runs once a minute and does one small job per run, to stay inside the free plan's 10 ms
of CPU. While the daily sync of the [official MCP Registry](https://registry.modelcontextprotocol.io) is
in progress, even minutes read one page (latest versions only) and odd minutes check one queued server,
so servers are listed while the sync is still going. Otherwise it checks one queued server (never the
same host twice in a row) and lists it if it responds, or re-checks one listed server whose report is a
week old. Servers that need a per-user key (required headers, URL
placeholders, query strings) or have no public URL are skipped, and a server is dropped after three
failed attempts. Every request sends `User-Agent: MCP-Check/0.1 (+https://mcp.nischaldhakal.com.np)`.
Progress: `GET /api/stats`.

## Search

Directory search combines two rankings with reciprocal rank fusion:

- **Keywords**: a SQLite FTS5 index in D1 over each server's name, description, tools and URL, kept
  current by triggers on the `servers` table. Results say which tool matched.
- **Meaning** (optional): each server's name, description and tools are embedded with Workers AI
  (`@cf/baai/bge-small-en-v1.5`, 384 dimensions) into a Vectorize index, so "send email" also finds a
  Gmail server. The cron run embeds up to 25 changed servers at a time.

To turn on meaning search, create the index and add the bindings to `wrangler.jsonc`:

```bash
npx wrangler vectorize create mcp-servers --dimensions=384 --metric=cosine
```

```jsonc
"ai": { "binding": "AI" },
"vectorize": [{ "binding": "VECTORS", "index_name": "mcp-servers" }],
```

Without them, or if either fails or runs out of free quota, search uses keywords only. Searches are
cached at the edge for a minute.

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
- [x] Shareable reports and README badges
- [x] Public directory with server pages and weekly re-checks
- [x] Automatic import from the official MCP Registry
- [x] Hybrid search: keywords and meaning
- [ ] OAuth sign-in to inspect protected servers
- [ ] `npx mcp-check` CLI and GitHub Action
- [ ] Webhook and RSS alerts

## License

MIT
