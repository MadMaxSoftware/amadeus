# Amadeus public roadmap

This roadmap describes public product direction and release gates. Internal
branch history, private test-machine details, and unresolved development notes
are intentionally kept outside the distributable repository.

Related: `docs/PROJECT_CHARTER.md`, `docs/VALIDATION.md`, `docs/UPDATE.md`, and
`PRIVACY.md`.

## 0.3.x — Public trust and portable coordination

The 0.3 series establishes the privacy and portability baseline:

- default-deny external data flows and explicit, revocable consent;
- consent-based update checking, staging, approval, rollback, and restart;
- optional computer-only provider discovery with loopback-only endpoints;
- per-machine provider configuration stored outside the public package;
- packaged coordination that works without Cursor and can use it when present;
- default trusted SessionStart coordination that remains lightweight,
  bypassable, and recursion-safe;
- deterministic privacy, integrity, packaging, and behavior checks.

Version 0.3.2 packages the coordinator runtime and registered Setup while
keeping automatic local-model routing disabled on the stable channel.
Version 0.3.4 makes packaged runtime authority and project-bound repair the
public default while retaining migration-only readers for existing local state.
Version 0.3.3 added durable per-machine state migration and reviewed legacy-state
consolidation, strengthens deterministic verification, and replaces
developer-facing startup permission wording with plain-language host copy
(`Start Amadeus automatically`). Packaged runtime is executable authority by
default; persisted setup roots are migration hints only; developer source mode
is explicit and fail-closed; self-repair cannot mutate foreign host trees.

## 0.4.x — Cross-host portability

The Vendor Independence foundation now includes a canonical asset manifest and
deterministic Codex wrapper generator, plus the host parity contract in
`docs/HOST_COMPATIBILITY.md`. The first non-OpenAI
pilot is Claude Code. Version 0.3.7 publishes the Claude Code host package and
direct GitHub marketplace lifecycle from the shared engine while keeping
Claude-as-worker optional; see `docs/CLAUDE_CODE.md`. Full matrix promotion
still depends on
clean non-sandbox SessionStart evidence where app-sandbox Git-bash limits apply.
Version 0.3.8 repairs Windows package verification, optional-Cursor fallback,
and isolated legacy-state resolution, and publishes a custom-plugin ZIP for the
Claude Desktop upload flow.
Version 0.3.10 makes hard provider-environment failures durable for the current
goal, restores trusted origin-host closeout for the latest stopped iteration,
and verifies both Claude marketplace catalogs in the isolated package build.
Other host support still needs a consented pilot.

## 0.5.x — Qualified local-model routing

Stable automatic routing to approved local models may be enabled only after the
public gate in `docs/LOCAL_MODEL_PILOT.md` passes. Detection alone never grants
work authority. Each provider must be explicitly approved and each model may
receive only the task capabilities it demonstrates.

The intended routing order is:

1. ordinary software for deterministic work;
2. an approved local model qualified for the task;
3. optional Cursor when installed and suitable;
4. a capable signed-in Codex model.

## Later milestones

- Improve clean-machine installation, onboarding, and upgrade verification.
  A temporary packaged-checkout test now covers private-state seeding and
  repeat setup; host marketplace activation and a desktop restart still need
  separate installed-host evidence.
- Strengthen owner-facing progress and provider attribution without expanding
  authority or collecting telemetry.
- Keep Maestro as an alias for Amadeus, with the same behavior and orchestrator.
- Harden isolation, patch integrity, recovery, and performance from verified
  failure evidence.

## Release principles

Every stable release must:

- keep privacy-safe core functionality usable when optional consent is declined;
- reject undeclared network behavior and non-loopback local-provider endpoints;
- keep credentials, prompts, source, paths, hardware details, model inventory,
  benchmarks, and execution traces out of release artifacts;
- pass `npm run test:packaged`, `npm test`, `npm run public-safety`,
  `npm run workspace-diff-check`, and `git diff --check`;
- document user-visible changes and preserve rollback or recovery paths;
- require separate approval for update activation and provider enablement.

Self-evolution, telemetry, automatic upstream feedback, and community learning
are not part of the current stable roadmap. Any future proposal in those areas
requires a separate privacy-impact review and versioned governance amendment.

## Deterministic Windows application control

Amadeus has a generic no-model route for explicit Windows UI plan objectives.
ZEISS INSPECT is the first compatibility fixture, not a separate automation
engine. Plans live under `.amadeus/ui-plans/`, bind to one exact executable and
one matching window, and default to inspection/dry-run behavior. The fixed host
helper supports bounded inspection, focus, and explicitly listed
standard controls: typing through `ValuePattern`, invoke, selection, toggle,
expand, and collapse. The host AI and its existing policies decide which
application work is appropriate; Amadeus does not maintain application-specific
policy code. Unsupported or unavailable UI Automation stops with a receipt
instead of silently spending a model call. Application-specific selectors stay
in data plans while the engine remains generic.

The linked Codex thread that mentioned a workspace-size warning was unavailable
on its durable host during this change. Amadeus admission limits remain
unlimited (`maximumChangedFiles` and `maximumChangedLines` are `null`), so no
unrelated security or patch limit was raised without the original diagnostic.
