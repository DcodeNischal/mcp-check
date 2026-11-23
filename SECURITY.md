# Security policy

MCP Check contacts servers on other people's behalf, so its safety matters. Thank you for helping keep it
safe.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately through GitHub:
go to the repository's **Security** tab and choose **Report a vulnerability**. Include what you found,
how to reproduce it, and what an attacker could do with it.

You'll get a reply within a few days. Once it's fixed, you're welcome to be credited in the release notes.

## What's in scope

- The website and API at `mcp.nischaldhakal.com.np`, and its MCP server at `/mcp`.
- The CLI (`@dcodenischal/mcp-check`) and the GitHub Action.
- Especially: ways to make MCP Check contact private or internal addresses, leak credentials people
  provide, forge or tamper with stored grades, abuse it to send traffic to third parties, or bypass the
  ownership proof for verifying or removing servers.

Please test only against servers you own or have permission to test, and don't run load tests against the
hosted service.
