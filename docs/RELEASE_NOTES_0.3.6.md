# Amadeus 0.3.6 - Visible progress and restored Cursor routing

Amadeus 0.3.6 turns the latest roadmap work into a public patch release. It
improves owner-facing progress reporting, restores the optional Cursor worker
route, and removes an unnecessary distinction between Amadeus and its Maestro
alias.

## Progress that explains the work

- Long-running work reports concrete activity and completed milestones instead
  of repeating a generic lease heartbeat.
- Completion and setback reporting identifies the actual work, remaining work,
  worker route, and any owner action that is genuinely required.
- Migrated worker receipts are audited from their durable location, avoiding
  duplicate or missing accounting after state migration.

## Cursor route restored

- Existing Cursor provider settings migrate into the current configuration
  instead of being silently treated as disabled.
- Cursor execution uses the same project-scoped isolation contract as other
  model workers.
- A host acceptance harness checks workspace access, denied parent and evidence
  paths, protected metadata, and write boundaries before dispatch is enabled.
- The release was exercised with an installed Cursor command-line canary as
  well as repository tests. Cursor remains optional.

## One product, two names

Maestro is simply an alias for Amadeus. It has the same instructions, behavior,
reporting, and orchestration engine. This release removes language and tests
that incorrectly treated Maestro as a separate personality or product mode.

## Package foundation, without premature support claims

- A canonical package now generates and verifies the Codex wrapper and packaged
  runtime with versioned integrity manifests.
- An inert Claude Code fixture tests static package parity only. Claude Code is
  not installed, activated, or advertised as a supported Amadeus host in this
  release; a real local pilot must pass the published parity gate first.

## Privacy and compatibility

- No telemetry or new data collection is introduced.
- Optional provider discovery, Cursor use, and update checks remain separately
  controlled.
- Existing packaged-runtime authority, worker isolation, and public-safety
  protections remain in force.

## Update

Upgrade from the Amadeus marketplace and restart Codex / ChatGPT desktop:

```bash
codex plugin marketplace upgrade amadeus
```
