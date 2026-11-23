# MCP Check

Check, grade and explore any remote [Model Context Protocol](https://modelcontextprotocol.io) server, for free.
Paste a URL and get an A–F report on protocol compliance, tool quality, OAuth setup, security and speed.

Live at **[mcp.nischaldhakal.com.np](https://mcp.nischaldhakal.com.np)**, in your terminal with
`npx @dcodenischal/mcp-check <url>`, and in CI as a [GitHub Action](#github-action). Built by
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

**Grading.** Each check has a weight; a pass earns its full weight, a warning half, a failure none,
and the total out of 100 sets the grade (A 90+, B 80+, C 70+, D 60+). Rules a spec says servers
MUST follow are failures when missed (accepting a foreign `Origin` is one), being one revision behind
is a warning, and two or more is a failure. Serving over plain HTTP or leaking stack traces holds the
grade at B at best. When the rules change, stored reports are regraded in the background without
sending grade-change alerts.

## How it works

- `src/mcp/`: an MCP client built for checking. It detects the server's era, records every message
  and timing, and enforces size and time limits.
- `src/checks/`: the graded rules. The same code runs in the Worker (online checks) and, later, the CLI
  (local and stdio servers), so grades match everywhere.
- `src/security/target.ts`: which URLs may be contacted. Online checks only reach public HTTPS hosts,
  including URLs a server hands back during OAuth discovery.
- `src/worker/`: the Cloudflare Worker API. `src/app/`: the Vue frontend.

## Directory

Shared reports can be listed at `/servers`. Reports made with credentials are never listed. Listed
servers are re-checked once their report is a week old; three failed re-checks in a row unlist it.

Owners prove control of a server by serving a line at `https://<their-domain>/.well-known/mcp-check.txt`
and pressing the button on its page:

- `mcp-check: verify <id>` shows a verified-owner mark on the server's page and in the directory. It's
  re-confirmed at every weekly re-check and dropped if the line is gone.
- `mcp-check: remove <id>` takes the server out of the directory. Verifying again lists it again, so only
  the domain's owner can remove a server or bring it back.

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

## Sign-in for protected servers

For servers that require OAuth, "Sign in with OAuth" runs the authorization code flow with PKCE (S256)
against the server's own authorization server, found through its protected resource metadata. MCP Check
is a public client: where the authorization server supports
[Client ID Metadata Documents](https://modelcontextprotocol.io/specification/draft/basic/authorization),
its client id is `https://mcp.nischaldhakal.com.np/oauth/client.json`; otherwise it registers through
Dynamic Client Registration (once per authorization server). Servers that need an app registered by
hand can still be checked by pasting a token.

The sign-in is tied to the browser that started it with a cookie. After the callback, the Worker holds
the access token only until the page claims it (once, within ten minutes), then deletes it. The token
then lives only in that browser tab, and reports made while signed in are never listed.

## Alerts

- **Feeds:** [`/feed.xml`](https://mcp.nischaldhakal.com.np/feed.xml) lists servers added to the
  directory, grade changes, and servers dropped after failing three weekly re-checks in a row. Each
  server has its own feed at `/r/<id>/feed.xml`.
- **Webhooks:** from a server's page, anyone can add a webhook (up to five per server). It must answer
  a test message with 2xx first. Slack and Discord webhook URLs get a readable message; other URLs get
  JSON like this, signed with `X-MCP-Check-Signature: sha256=<HMAC-SHA256 of the body>`:

  ```json
  {
    "type": "grade_changed",
    "server": { "id": "…", "url": "https://…/mcp", "name": "…", "reportUrl": "https://mcp.nischaldhakal.com.np/r/…" },
    "grade": "A", "previousGrade": "C", "score": 93, "previousScore": 74,
    "message": "… improved from C to A (74 → 93/100)",
    "at": "2026-11-23T01:00:00.000Z"
  }
  ```

  `type` is `listed`, `grade_changed` or `unreachable` (and `ping` for the test). Failed deliveries are
  retried after 5 minutes, 30 minutes and 2 hours; a webhook is switched off after ten dropped deliveries
  in a row. To remove one: `POST /api/webhooks/<id>/delete` with `{"secret": "…"}`.

Events are recorded by triggers on the `servers` table, so every path that lists, re-grades or drops a
server produces one. A server's owner removing it doesn't.

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

## Command line

```bash
npx @dcodenischal/mcp-check https://mcp.example.com/mcp
npx @dcodenischal/mcp-check http://localhost:3000/mcp --min-grade B     # fail (exit 1) below a B
MCP_CHECK_TOKEN=... npx @dcodenischal/mcp-check https://mcp.example.com/mcp --markdown
```

The same checks as the website, run from your machine, so servers on `localhost` and plain `http` work
too. Options: `-H "Name: value"`, `--token`, `--min-grade`, `--min-score`, `--json`, `--markdown`,
`-v`, `--timeout`, `--no-color`. Exit codes: `0` passed, `1` below the minimum, `2` unreachable or bad
usage. See [cli/README.md](cli/README.md).

## GitHub Action

```yaml
name: MCP server
on: [push, pull_request]
jobs:
  grade:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm start &
      - uses: DcodeNischal/mcp-check@v1
        with:
          url: http://localhost:3000/mcp
          min-grade: B
          # token: ${{ secrets.MCP_TOKEN }}
          # headers: |
          #   X-Api-Key: ${{ secrets.API_KEY }}
```

It prints the report, adds a summary to the job, annotates failed checks, and fails the step below
`min-grade` or `min-score`. Outputs: `grade`, `score`, `passed`, and `report` (a path to the JSON
report). Token and header values are masked in the log.

The command line and the action are bundled into `cli/bin/mcp-check.mjs` and `action/index.mjs` with
`npm run build:cli`; both are committed so neither needs an install. CI checks they're up to date.

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
- [x] OAuth sign-in to inspect protected servers
- [x] `npx @dcodenischal/mcp-check` command line and GitHub Action
- [x] Webhook and feed alerts

## License

MIT
