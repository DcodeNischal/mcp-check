# @dcodenischal/mcp-check

Grade an MCP server against the current spec, from your terminal or CI. The same checks as
[MCP Check](https://mcp.nischaldhakal.com.np), run from your machine, so servers on `localhost` work too.

```bash
npx @dcodenischal/mcp-check https://mcp.example.com/mcp
```

```
MCP Check  https://mcp.example.com/mcp

  Grade A  92/100  spec 2026-07-28 (stateless HTTP) · 3 tools · checked in 1.3s

  ! Tools say whether they change things (Tools)
    0 of 3 tools declare readOnlyHint or destructiveHint. Without them, clients must assume every tool may be destructive and ask users to confirm each call.
    Fix: Add annotations: { readOnlyHint: true } to tools that only read, and destructiveHint to tools that delete or overwrite.

  16 passed · 1 warning · 0 failed
```

It checks the protocol (all three spec versions: 2026-07-28 stateless HTTP, Streamable HTTP and the
older HTTP+SSE), tool definitions and schemas, OAuth discovery, security (Origin checks, error leaks)
and speed, and tells you how to fix each problem.

## Options

| Option | |
|---|---|
| `-H, --header "Name: value"` | Send a header with every request (repeatable) |
| `--token <token>` | Send `Authorization: Bearer <token>` (or set `MCP_CHECK_TOKEN`) |
| `--min-grade <A-F>` | Exit with code 1 if the grade is below this |
| `--min-score <0-100>` | Exit with code 1 if the score is below this |
| `--json` | Print the full report as JSON |
| `--markdown` | Print a Markdown summary (for pull request comments) |
| `-v, --verbose` | Also list the checks that passed |
| `--timeout <seconds>` | Time limit per request (default 15) |
| `--no-color` | Plain output (also `NO_COLOR=1`) |

Exit codes: `0` passed, `1` below `--min-grade` or `--min-score`, `2` server unreachable or bad usage.

## In CI

```bash
npm start &                     # your server
npx @dcodenischal/mcp-check http://localhost:3000/mcp --min-grade B
```

On GitHub, the [MCP Check action](https://github.com/DcodeNischal/mcp-check#github-action) does the
same and adds a summary to the job:

```yaml
- uses: DcodeNischal/mcp-check@v1
  with:
    url: http://localhost:3000/mcp
    min-grade: B
```

Requires Node.js 20 or later. MIT licensed. Made by [Nischal Dhakal](https://nischaldhakal.com.np).
