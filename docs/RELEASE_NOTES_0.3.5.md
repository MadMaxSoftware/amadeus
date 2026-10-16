# Amadeus 0.3.5 - Reliable optional-provider startup

Amadeus 0.3.5 is a focused reliability patch for clean installations and
computers that do not use Cursor.

## Startup fix

- Disabled optional Cursor support is now skipped before Amadeus constructs a
  Cursor-specific environment.
- An enabled but incomplete optional Cursor configuration is reported as
  unavailable instead of crashing the coordinator.
- Ordinary software and available signed-in Codex routes can therefore continue
  normally when Cursor is absent, disabled, or not fully configured.

## Clearer product description

The README and plugin description now explain that Amadeus reduces average AI
usage across mixed workflows by using ordinary software for deterministic work
and avoiding unnecessary repeated model attempts. This can preserve subscription
allowance and reduce usage-based costs. No universal savings percentage is
claimed without comparable measured evidence.

## Privacy and compatibility

- No telemetry or new data collection is introduced.
- Local goals, history, and provider settings remain outside the public package.
- The packaged-runtime authority and project-bound repair protections introduced
  in v0.3.4 remain unchanged.

## Verification

Regression tests cover disabled optional Cursor support and incomplete optional
Cursor configuration. The complete repository, packaged-runtime, privacy,
public-safety, workspace-diff, and release checks pass before publication.
