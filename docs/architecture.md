# How MCP Check works

This is the inside view: how the code is laid out, how checks run, and how the whole thing stays on
Cloudflare's free plan. For using MCP Check, see the [README](../README.md).

## Code layout

| Path | What's there |
|---|---|
| `src/mcp/` | An MCP client built for checking: detects the server's spec era, records every message and timing, and enforces size and time limits. |
| `src/checks/` | The graded rules and the grading itself (`grade.ts`). The same code runs on the website, in the MCP server, in the CLI and in the GitHub Action, so grades match everywhere. |
| `src/security/target.ts` | Which URLs may be contacted. Online checks only reach public HTTPS hosts, including URLs a server hands back during OAuth discovery. The CLI allows `localhost`. |
| `src/worker/` | The Cloudflare Worker: the API, the MCP server, the directory, search, alerts, sign-in and the scheduled jobs. |
| `src/app/` | The Vue frontend. |
| `cli/` | The command line and the GitHub Action, bundled into `cli/bin/mcp-check.mjs` and `action/index.mjs`. |
| `docs/spec-notes.md` | The spec facts every rule is based on. |

## Grading

Each check has a weight. A pass earns its full weight, a warning half, a failure none, and the total out
of 100 sets the grade (A 90+, B 80+, C 70+, D 60+, F below). Rules the spec says servers MUST follow are
failures when missed (accepting a foreign `Origin` is one). Speaking the previous spec revision is a
warning; two or more revisions behind is a failure. Serving over plain HTTP or leaking stack traces holds
the grade at B at best. Info checks don't count either way.

`GRADING_VERSION` in `src/checks/grade.ts` is bumped whenever the rules change; stored reports are then
regraded in the background, and a grade that changes only because the rules changed doesn't send alerts.

## Scheduled work

One cron trigger fires every minute. Each run:

1. Does upkeep: fills in derived columns for older reports (and regrades them after a rule change),
   embeds changed servers for search, refreshes the directory stats every 30 minutes, checks MCP Check's
   own server once a day, and sends queued webhook deliveries.
2. While the daily sync of the [official MCP Registry](https://registry.modelcontextprotocol.io) is in
   progress, reads one page of it (latest versions only).
3. Checks four queued servers at once. Each check runs through the Worker's own `Checker` entrypoint via a
   service binding, so it's a separate invocation with its own CPU budget (a single run gets about 10 ms of
   CPU on the free plan). A server is claimed in the database before it's checked, so concurrent runs never
   check the same one.
4. When the queue is empty, re-checks one listed server whose report is a week old. Three failed re-checks
   in a row unlist it.

The queries that run every minute or on every directory view all have matching indexes, so each reads a
handful of rows; the free plan allows 5 million rows read a day.

## Registry import

Servers in the registry with a public Streamable HTTP or SSE URL are queued, checked, and listed if they
respond. Servers that need a per-user credential (a required header, a URL placeholder or a query string)
can't be graded fairly without it, so they aren't checked. A queued server is dropped after three failed
attempts. Every request sends `User-Agent: MCP-Check/0.1 (+https://mcp.nischaldhakal.com.np)`.

## Directory and owners

Reports are saved only when someone shares one (or the import lists a server), and only with a signature
from the Worker that produced the grade, so nobody can upload a made-up grade. Reports made with
credentials are never listed.

Owners prove control of a server by serving a line at `https://<domain>/.well-known/mcp-check.txt`:
`mcp-check: verify <id>` gives the server a verified-owner tick (re-confirmed at every weekly re-check),
and `mcp-check: remove <id>` takes it out of the directory until the owner verifies again.

## Search

Directory search merges two rankings with reciprocal rank fusion:

- **Keywords:** a SQLite FTS5 index in D1 over each server's name, description, tools and URL, kept
  current by triggers on the `servers` table. Results say which tool matched.
- **Meaning:** each server's name, description and tools are embedded with Workers AI
  (`@cf/baai/bge-small-en-v1.5`, 384 dimensions) into a Vectorize index, so "send email" also finds an
  email server that never uses the word "send". If either service fails or runs out of free quota,
  search uses keywords only.

## Sign-in for protected servers

"Sign in with OAuth" runs the authorization code flow with PKCE (S256) against the server's own
authorization server, found through its protected resource metadata. MCP Check is a public client: where
the authorization server supports Client ID Metadata Documents, its client id is
`https://mcp.nischaldhakal.com.np/oauth/client.json`; otherwise it registers through Dynamic Client
Registration (once per authorization server). Servers that need an app registered by hand can still be
checked by pasting a token.

The sign-in is tied to the browser that started it with a cookie. After the callback, the Worker holds the
access token only until the page claims it (once, within ten minutes), then deletes it.

## Alerts

Triggers on the `servers` table record an event whenever a server is listed, changes grade, or is dropped
after failing re-checks; each event queues a delivery for every active webhook on that server.

Webhooks must answer a test message with 2xx before they're saved (five per server at most). Slack and
Discord webhook URLs get a readable message; other URLs get JSON signed with
`X-MCP-Check-Signature: sha256=<HMAC-SHA256 of the body>`:

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
retried after 5 minutes, 30 minutes and 2 hours; a webhook is switched off after ten dropped deliveries in
a row. To remove one: `POST /api/webhooks/<id>/delete` with `{"secret": "…"}`.

## Running your own

Everything runs on Cloudflare's free plan. You need a D1 database, a rate-limit binding, a Turnstile
widget (`TURNSTILE_SECRET` as a Worker secret) and, for meaning search, a Vectorize index:

```bash
npx wrangler vectorize create mcp-servers --dimensions=384 --metric=cosine
```

The bindings are in `wrangler.jsonc`. Search works without the AI and Vectorize bindings, using keywords
only.
