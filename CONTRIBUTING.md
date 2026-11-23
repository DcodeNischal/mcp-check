# Contributing to MCP Check

Thanks for helping. The most useful contributions are:

- **False-positive reports:** a server that's graded down for something it does correctly. These matter
  more than anything else, because a grade people can't trust is worse than no grade.
- **New checks** for parts of the spec MCP Check doesn't cover yet.
- **Bug reports** for the website, the MCP server, the CLI or the GitHub Action.

Open an issue first for anything bigger than a small fix, so we can agree on the approach.

## Running it locally

```bash
npm install
npm test             # unit tests against fake servers for every spec era
LIVE=1 npm test      # also check a few real public servers
npm run dev          # the website and Worker on http://localhost:5173
npm run build        # type checks and production build
```

For local development, create `.dev.vars` with `DEV_SKIP_TURNSTILE=1` so the Worker skips the human check
(it only takes effect on `localhost`), and `.env.development.local` with
`VITE_TURNSTILE_SITEKEY=1x00000000000000000000AA`, Cloudflare's always-pass test key. Both files are
ignored by git; never commit secrets.

## How checks work

Each check produces a result like this:

```ts
{ id: 'security.origin', category: 'security', title: 'Rejects requests from other websites',
  status: 'pass' | 'warn' | 'fail' | 'info' | 'skip', weight: 3, detail: 'What was found.', fix: 'How to fix it.' }
```

- Protocol and security checks live in `src/checks/run.ts`, tool checks in `src/checks/tools.ts`, and auth
  checks in `src/checks/auth.ts`. Grading is in `src/checks/grade.ts`.
- `detail` says what MCP Check found, in plain words. `fix` says what to change, as one sentence a
  developer can act on.
- Use `fail` for things the spec says servers MUST do, `warn` for SHOULD and good practice, and `info` for
  facts that aren't graded.

## Adding a check

1. Find the rule in the spec and add it to [docs/spec-notes.md](docs/spec-notes.md) with the section it
   comes from. Every check must trace back to the spec.
2. Add the check next to similar ones, with an `id` of the form `<category>.<name>`.
3. Add tests in `test/` against the fake servers in `test/fixtures/servers.ts`: one where the check
   passes and one where it doesn't. If the fixtures can't express the case, extend them.
4. Run `npm test` and `npm run build`.
5. The CLI and the GitHub Action are bundled into committed files. If you changed anything they use, run
   `npm run build:cli` and commit `cli/bin/` and `action/` too (CI checks they match the source).

If the change alters existing grades, bump `GRADING_VERSION` in `src/checks/grade.ts` and update
`regrade()` so stored reports are regraded.

## Pull requests

- Keep each pull request to one change, with tests.
- Write commit messages that say what changed and why.
- By contributing, you agree your contribution is licensed under the project's MIT license.
