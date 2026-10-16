# Amadeus 0.4.1 - Codex and Claude as equal workers

Amadeus 0.4.1 treats Codex and Claude as interchangeable worker providers,
makes verification reports honest about what was actually tested, and removes
code that could never run.

## Equal providers

- **Whichever provider is installed runs.** A machine with only Claude Code, or
  only Codex, uses that one. With both, an owner preference
  (`preferredProvider` in the worker config) wins; otherwise workers use the
  provider the host chat is not running on, so a long goal does not use up the
  allowance the owner is chatting with.
- **Same capability tiers on both.** Simple, normal and hard steps get the
  same tier on either provider; on Claude that is Sonnet for the efficient tier
  and Opus for the workhorse and frontier tiers.
- **A diagnosed failure moves the retry to the other provider.**
- **Claude workers need no separate setup in development mode.** A signed-in
  Claude Code install plus the Codex CLI (which provides the Windows sandbox) is
  enough.
- **Same sandbox for Claude.** Claude development workers get the Codex policy:
  credential and tool-login folders, browser profiles and personal folders are
  denied (except Claude's own sign-in folder), project writes stay in the
  worker's copy, and every run verifies this before any model call.
  `npm run claude:worker-live-check` repeats the check with one real Claude call.
- **One setting for commands.** `workerCommandsEnabled` (on by default) decides
  whether workers may run commands, for both providers. On Windows, Claude runs
  commands through PowerShell.

## Honest verification

- Every check is labelled as an integrity check or a project test. When no
  project tests ran, the report says "Integrity check only" and names the
  changed languages that went untested.
- Optional pytest, Go and .NET test runners, enabled per project in
  `.amadeus/verify.json`.

## Goals

- Worker decisions carry a structured `hostHandoff` field instead of being
  recognised from English wording, so status, resume and start agree on when a
  goal is waiting on the host.
- A goal step without a decision no longer has its change applied to the
  project.
- A worker can no longer route a later step to Windows desktop automation; only
  the owner's own goal objective can.
- One failed stop-request check no longer aborts a healthy worker.

## Privacy and isolation

- Codex and Cursor workers no longer inherit credential-named environment
  variables (for example tokens and cloud keys).

## Removed

- The unused staged-update, activation and rollback code. Update checks are
  check-only and manual; `docs/UPDATE.md` describes the actual behaviour.
- The internal opaque-evaluation profile. The goal database is upgraded to
  schema version 3 automatically on first open.

## Project

- `server.mjs` and `coordinator.ts` are split into smaller modules.
- The sandboxed public-safety scan works again.
