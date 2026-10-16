# Amadeus 0.3.3 - Durable local state and clearer startup permission

Amadeus 0.3.3 preserves the 0.3.2 default coordination model while adding a
reviewed path for carrying durable, per-machine user state between installations
and replacing technical startup wording with language ordinary users can
understand.

## What changed

- Renames the startup permission status message to
  **Start Amadeus automatically**.
- Adds a short, plain-language description: Amadeus becomes available in new
  chats for longer-task coordination, runs locally at startup, and does not
  scan the computer or send personal information.
- Aligns Setup, onboarding, install, and README guidance with that same wording
  so users are not asked to approve unexplained developer terminology.
- Adds explicit inspect, plan, apply, verify, recovery, and rollback workflows
  for moving durable state to a stable per-machine location outside the plugin
  package.
- Adds conservative multi-root consolidation for legacy coordinator histories:
  active goals are preserved, conflicting records fail closed, losing variants
  remain recoverable, and publication is atomic and reversible.
- Adds regression coverage for cache replacement, interrupted migration,
  consolidation conflicts, rollback, and large state trees.
- Strengthens deterministic verification discovery so changed tests use their
  repository-provided sandbox runners where available.

## What did not change

- No telemetry, fault intake, or repository feedback service.
- Default trusted coordination and registered Setup remain enabled as in 0.3.2.
- Existing state is never uploaded and is not silently consolidated. Migration
  and consolidation require an explicit local command and retain recovery data.
- Update checks remain consented, fixed to `MadMaxSoftware/amadeus`, and require
  explicit activation approval plus a desktop restart.
- Computer-only provider discovery remains consented and loopback-scoped.
- Local-model automatic routing stays **disabled** on the stable channel until
  the public release gate in `docs/LOCAL_MODEL_PILOT.md` passes.
- Public-trust guardrails from 0.3.1 and 0.3.2 remain in force.

## Upgrade

```bash
codex plugin marketplace upgrade amadeus
```

Restart Codex / ChatGPT desktop after upgrading. Confirm the installed cache
version matches `plugins/amadeus/.codex-plugin/plugin.json` (`0.3.3`).

## Related docs

- `docs/RELEASE_NOTES_0.3.2.md` - packaged runtime and default coordination
- `docs/ONBOARDING.md` - first-run Setup and startup permission
- `docs/STATE_MIGRATION.md` - durable local-state migration and consolidation
- `docs/UPDATE.md` - consent-based check / stage / approve / rollback
- `docs/VALIDATION.md` - local and sandbox verification commands
