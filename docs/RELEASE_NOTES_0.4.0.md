# Amadeus 0.4.0 - Safe unattended runs

Amadeus 0.4.0 makes long, unattended goals safer and more predictable, and
restarts the public history from a single reviewed snapshot.

## Unattended runs

- **Progress limits.** A goal pauses and asks the owner after 3 failed or blocked
  attempts in a row, 6 iterations in a row with no applied change, or 60 AI-worker
  calls in 24 hours (ordinary software steps don't count). Answering the question
  starts a fresh set of attempts. This replaces spending limits that were never
  enforced.
- **Usage limits.** When a subscription provider's usage window is exhausted, the
  goal pauses with the same step queued and resumes by itself after the stated
  reset time, instead of spending retries.
- **Completion needs evidence.** An uncertain job can be closed as completed only
  on a verified worker receipt that records a complete decision.
- **Daily backups** of the goal database, keeping 7 daily and 4 weekly copies.

## Isolation and privacy

- Codex development workers can no longer read credential and tool-login
  folders, browser profiles, application data or personal folders. Each run
  verifies this before any model call; `npm run codex:sandbox-probe` repeats the
  check without a model.
- Worker command network access is off unless the owner turns it on, and the
  runtime limit per worker run applies again.
- Every subscription-provider dispatch is checked against the declared privacy
  flows; Claude is now declared.
- Work cannot target the installed plugin folder; a local repair note is saved
  instead.

## Fixes

- The update check works in the Claude Code package and suggests that host's
  upgrade command.
- Usage is attributed to the model that actually ran, and Codex is no longer
  forced onto a fixed model name.
- Windows paths with spaces, and non-Windows paths, no longer break the
  command-line entry points; directory renames during state migration retry
  through transient Windows file locks; a failed heartbeat now rolls back.
- Worker heartbeats no longer grow the goal history during long runs.

## Project

- Licensed under the Apache License 2.0.
- Strict TypeScript checking runs in CI.
- The package is machine-agnostic and contains no personal paths or private
  project names; owner-private terms for leak scanning live in a local,
  git-ignored file.
