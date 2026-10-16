# Amadeus 0.3.8 - Windows reliability and Claude Desktop packaging

Amadeus 0.3.8 is a patch release for the public 0.3.7 host integration.

## Fixed

- An installed but unaccepted optional Cursor accelerator no longer blocks the
  safe Codex subscription baseline. Cursor remains fail-closed when it is the
  selected route; automatic work can continue through Codex.
- Claude package integrity checks now compare canonical text content, so a
  normal Windows CRLF checkout verifies without weakening binary integrity.
- State-root resolution now uses the caller-supplied environment consistently
  and no longer leaks the host's legacy state path into isolated tests.

## Claude Desktop

The release includes `amadeus-claude-plugin-0.3.8.zip` for upload through
**Claude Desktop > Customize > Plugins**. The Claude Code marketplace commands
remain supported for local Code sessions. Skills work in Chat, Cowork, and
Claude Code; Amadeus's local MCP server and SessionStart hook run in Cowork and
Claude Code, not ordinary Chat.

## Verification

- Full coordinator and migration suite.
- Packaged Codex and Claude distributions from a normal Windows checkout.
- Public-safety and privacy scans.
- Public GitHub Claude marketplace installation.
- Signed-in Claude SessionStart, skills, MCP connection, and same-engine canary.

Housekeeping: examined=coordinator preflight,Cursor route selection,Claude package builder,release metadata,install guidance,host compatibility,state-root compatibility; removed_or_quarantined=none; preserved=historical release notes,durable user state,privacy consent,existing Codex and Claude install commands
