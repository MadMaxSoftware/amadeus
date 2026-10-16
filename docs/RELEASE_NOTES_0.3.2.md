# Amadeus 0.3.2 — Default coordination and packaged runtime

Amadeus 0.3.2 ships the stable release-path package: trusted SessionStart
coordination after install and hook trust, a packaged coordinator runtime with
registered Setup, and the existing consent-based update and discovery controls.

## What changed

- Packages the coordinator and isolation helpers inside the installable plugin.
- Registers Setup so users can finish local configuration without a private
  setup tree.
- Enables default coordination through a trusted SessionStart hook in supported
  local chats. Ordinary conversation stays lightweight; users can bypass Amadeus
  per task.
- Keeps optional computer discovery separate from ordinary dependency checks.
  Discovery still needs scoped consent and a separate scan request.
- Keeps self-repair from silently mutating an installed public copy. Failed work
  and local evidence can be preserved for review; source changes continue through
  the normal tested branch and pull-request workflow.

## What did not change

- No telemetry, fault intake, or repository feedback service.
- Update checks remain consented, fixed to `MadMaxSoftware/amadeus`, and require
  explicit activation approval plus a desktop restart.
- Computer-only provider discovery remains consented and loopback-scoped.
- Local-model automatic routing stays **disabled** on the stable channel until
  the public release gate in `docs/LOCAL_MODEL_PILOT.md` passes.
- Public-trust guardrails from 0.3.1 remain in force (`PRIVACY.md`,
  `docs/RELEASE_NOTES_0.3.1.md`).

## Upgrade

```bash
codex plugin marketplace upgrade amadeus
```

Restart Codex / ChatGPT desktop after upgrading. Confirm the installed cache
version matches `plugins/amadeus/.codex-plugin/plugin.json`.

## Related docs

- `docs/LOCAL_MODEL_PILOT.md` — 0.4.x stable local-routing release gate
- `docs/ROADMAP.md` — public development phases
- `docs/UPDATE.md` — consent-based check / stage / approve / rollback
- `docs/VALIDATION.md` — local and sandbox verification commands
