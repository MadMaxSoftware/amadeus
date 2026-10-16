# Amadeus project charter

- **Product:** Amadeus — Local AI Orchestrator by Mad Max Systems
- **Alias:** Maestro (same Amadeus behavior and orchestration engine)
- **Public repository:** `https://github.com/MadMaxSoftware/amadeus`
- **Package version baseline:** `0.4.1` (`plugins/amadeus/.codex-plugin/plugin.json`)

This charter orients local and contributor development on the **public** marketplace
repository. It does not change runtime plugin behavior.

## Vendor Independence programme

The 0.4 series establishes cross-host portability before the 0.5
qualified local-model routing milestone. The single acceptance contract and
candidate matrix are in `docs/HOST_COMPATIBILITY.md`. Agent Plugins 1.0 is the
implemented canonical asset boundary; the Codex wrapper is generated from it,
while signed-in worker adapters remain independent of host
installation. Claude Code is the first non-OpenAI host published for install from
the shared package; Since 0.4.1 Claude and Codex are equal,
interchangeable worker providers (decision D5). Current Codex behavior and public-trust commitments stay intact.

## Current state

Amadeus is a Codex / ChatGPT plugin marketplace package plus a local
coordinator runtime that can live in the same repository checkout:

| Surface | Role |
| --- | --- |
| `.agents/plugins/marketplace.json` and root `marketplace.json` | Public marketplace catalog (keep relative paths) |
| `plugins/amadeus/` | Installable plugin (skills, MCP server, scripts) |
| `.claude-plugin/marketplace.json` and `claude-plugin/` | Public Claude Code marketplace, generated host plugin, and source for the Claude Desktop upload ZIP |
| `agent-package/` | Declared canonical assets for the generated Codex wrapper |
| `src/` | Coordinator source mirrored into `plugins/amadeus/runtime` for packaged authority |
| `docs/` | Public install, update, onboarding, validation, and planning |
| `config-templates/` | Privacy-clean templates; machine paths filled only outside the package |
| `scripts/` | Optional local activate / repair / dependency helpers |

Users install from the same public repository with
`codex plugin marketplace add MadMaxSoftware/amadeus` or
`claude plugin marketplace add MadMaxSoftware/amadeus` followed by
`claude plugin install amadeus@amadeus`.
They do **not** need any private host setup tree. Per-machine config is written
by `npm run amadeus:onboard` under the local Amadeus app-data folder (see
`docs/ONBOARDING.md`), never shipped inside the distributable.

## Product principles

1. **Owner outcomes over machinery** — Report finished work, remaining work, and
   genuine owner actions in plain language.
2. **Persist until done** — Unfinished goals stay visible; worker failure must
   not silently complete or erase requested work.
3. **Ordinary software first** — Searches, tests, builds, and deterministic
   transforms run without buying another model turn.
4. **Economical subscription routing** — Use the lowest capable available
   signed-in route; never invent model availability or enable API-key billing.
5. **Public-safe by default** — No personal paths, private project names,
   credentials, receipts, or machine-fixed Node paths in tracked artifacts.
6. **Portable across clean machines** — Relative marketplace paths; PATH-resolved
   `node`; Cursor optional.
7. **Fail closed on integrity** — Patch / whitespace / conflict checks gate
   apply; do not claim finished without verified evidence.
8. **Public trust outranks features** — Undisclosed or non-consensual collection
   and transmission are rejected, including when requested casually by the
   owner. Policy changes require the formal process in `PRIVACY.md`.

## Architecture boundaries

- **Plugin boundary:** `plugins/amadeus` is what users install. Skills
  (`amadeus`, `maestro`) and `.mcp.json` define the chat-facing surface.
- **Runtime boundary:** Public installs execute `plugins/amadeus/runtime` (packaged,
  version-checked). Developer source execution requires explicit developer mode
  plus Amadeus repository identity/version checks and fails closed on mismatch.
  Durable goals / SQLite live in a separate `stateRoot` (local Amadeus home by
  default), not in the marketplace package. Persisted `setupRoot` is not
  executable authority.
- **Config boundary:** Example and template configs stay empty of host paths.
  Filled machine config stays outside git.
- **Marketplace boundary:** Preserve the existing public layout and plugin
  behavior unless a roadmap milestone explicitly changes them.
- **Cross-host boundary:** A host is supported only after its claimed local
  surface passes the parity gate in `docs/HOST_COMPATIBILITY.md`; web/mobile
  surfaces without local hooks/runtime cannot receive full-support claims.
- **Authority boundary:** Local development does not imply permission to
  publish, push, deploy, message people, delete recovery copies, or buy
  provider overage.

## Privacy and portability rules

- Run `npm run public-safety` before release candidates. It scans tracked and
  distributable files, then performs the installable-plugin privacy scan.
- Network-capable behavior must use a flow declared in
  `plugins/amadeus/privacy-flows.json` and fail closed on recipient, category,
  or consent mismatch.
- Banned in tracked / distributable text: personal user home paths, private
  project identifiers, credential material, and fixed `Program Files` Node
  executable paths (see `plugins/amadeus/scripts/privacy-scan.mjs`).
- Prefer `node` on PATH in MCP and scripts; do not hard-code machine Node
  locations.
- Keep marketplace `source.path` values relative (`./plugins/amadeus`).
- Quarantine host-only leftovers under ignored paths (see `.gitignore`); never
  commit coordinator SQLite, goal packages, or private receipts.

## Optional Cursor behavior

- Cursor is an **optional accelerator**, never a baseline requirement.
- Missing Cursor must not block startup, preflight, or ordinary work.
- When Cursor is absent, continue with ordinary software plus available
  signed-in Codex / GPT models (`docs/ONBOARDING.md`, `detectAccelerators` in
  `amadeus-runtime.mjs`).
- Cursor Auto is treated as an opaque server-selected route unless live catalog
  evidence proves a concrete router mode.

## Model and tool routing

Balanced-quality policy for ordinary development (see skill guidance and
`src/work-routing.ts`):

| Tier | When |
| --- | --- |
| Ordinary software | Deterministic commands, checks, installs, transforms |
| Cursor Auto | Routine bounded implementation when Cursor is available |
| Efficient Codex | Lightweight reasoning, or when Cursor is unavailable |
| Workhorse Codex | Explicit complex design / diagnosis (record capability signals) |
| Frontier Codex | Explicit exceptional complexity only (record capability signals) |

- Do not pass `provider` / `model` / `reasoningEffort` unless the owner pins a
  route.
- After a diagnosed provider failure, prefer the other available provider for
  the automatic replacement (pinned evaluation routes stay pinned).
- Universal `git diff --check` (with CR-at-EOL allowed) gates patch integrity;
  project `package.json` `coordinator.verify` scripts and `.amadeus/verify.json`
  runners (pytest, go, dotnet) are hard gates only when configured. A run with
  no project test is reported as "Integrity check only".

## Amadeus / Maestro alias

- **Amadeus** (`$amadeus`, plugin `@Amadeus`) — Local AI Orchestrator: creative /
  inventive coordination posture while remaining evidence-driven and
  economical. Translates owner goals into durable coordinator work.
- **Maestro** (`$maestro`) — Alias for Amadeus. It uses the same instructions,
  behavior, engine, and tools.
- Both follow the same owner contract: ask only for consequential product,
  external/irreversible, credential/physical, or unresolvable factual choices.

## Acceptance criteria (charter-level)

A planning or packaging change is acceptable when:

1. Public marketplace layout and current plugin behavior remain intact unless a
   milestone explicitly changes them.
2. New docs stay consistent with README, INSTALL, UPDATE, ONBOARDING,
   VALIDATION, plugin metadata, and skills.
3. Privacy scan and repository-focused validation relevant to the change pass.
4. No private paths or private project data appear in tracked files.
5. Cursor remains optional in documentation and runtime assumptions.
6. Claims of completion cite verified checks or artifacts.
