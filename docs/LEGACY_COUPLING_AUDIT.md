# Legacy coupling audit (public Amadeus)

Audit date: 2026-10-14

Scope: active Amadeus repository surfaces that could couple a public install to a
legacy private host coordinator, private product identity, or unrelated project.

## Verdict

Public Amadeus must treat the **packaged plugin runtime** as executable
authority. Persisted `setupRoot` / `coordinatorRoot` values are **migration
hints only** and must not load, repair, or mutate a legacy host tree.

## Active surfaces examined

| Surface | Finding | Disposition |
| --- | --- | --- |
| `plugins/amadeus/scripts/amadeus-runtime.mjs` | Previously preferred machine-config / env setup roots before packaged runtime | **Corrected**: packaged default; developer source fail-closed |
| `plugins/amadeus/scripts/privacy-onboarding.mjs` | `configureRuntime` required setupRoot and wrote it as authority | **Corrected**: packaged write by default |
| `plugins/amadeus/scripts/onboard.mjs` | `--setup-root` could point installs at a host tree | **Corrected**: requires `--developer-mode` |
| `plugins/amadeus/scripts/server.mjs` | Goal packages could fall back to global worker manifest; special packages used setupRoot + missing PS | **Corrected**: require absolute `projectRoot`; opaque packages pre-provisioned only |
| `plugins/amadeus/runtime/src/supervisor.ts` (+ `src/`) | Nested `../..` + `coordinator/scripts` / `backup` PS layout | **Corrected**: Amadeus state root; project checkpoints; no parent-checkout manifest regen |
| `plugins/amadeus/runtime/src/codex-adapter.ts` (+ `src/`) | "Max development account read" sandbox label | **Corrected**: neutral Amadeus wording |
| `plugins/amadeus/scripts/state-migration.mjs` | Discover/migrate durable state; may read legacy home env | **Retained** as privacy-safe state migration only |
| `plugins/amadeus/scripts/self-repair-boundary.mjs` | New boundary module | **Added** |
| `plugins/amadeus/.mcp.json` | Env allow-list | Added `AMADEUS_DEVELOPER_MODE`; legacy state env remains read-only |
| `plugins/amadeus/config.example.json` | Example still mentioned setupRoot | Clarified non-authoritative + `runtimeAuthority` |
| `src/coordinator.ts` / packaged copy | Legacy state env for durable DB home | **Migration reader only** (not executable authority) |
| `docs/STATE_MIGRATION.md` | Documents legacy identifiers | Kept; updated authority language |
| Historical `docs/RELEASE_NOTES_*.md` | May mention prior behavior | **Historical evidence** — do not delete |
| Config templates / marketplace | No private host paths | Clean |

## Migration-only identifiers (retained)

These may remain only to preserve durable goals/history. They never select
executable Amadeus code or authorize self-repair:

- Legacy internal coordinator-home environment variable (constructed in source;
  never a public default product name)
- Former local app-data folder name used only when a coordinator database is
  already present there
- Persisted `setupRoot` / `legacySetupRootHint` for `<hint>/coordinator-state`
  sibling discovery
- Nested `coordinator/` layout detection inside an **explicit developer** source
  checkout after identity/version checks

## Removed or quarantined from active authority

- Persisted `setupRoot` / `coordinatorRoot` as executable runtime selectors
- Public onboarding that treats an arbitrary host tree as the coordinator
- Self-repair mutation of legacy host trees or unrelated projects
- Normal product identity under the former private coordinator app-data name

## Regression coverage

See `test/amadeus-runtime-authority.test.mjs` for:

- stale legacy config → packaged runtime + preserved stateRoot
- goal/history compatibility reader without source authority
- developer-mode foreign path and version mismatch fail-closed
- cross-project / legacy self-repair refusal + local artifact
- clean-machine portability without private setup env
- machine-config schema demotion to packaged authority

## Housekeeping note

Remnants that document historical migration behavior remain on purpose. Do not
reintroduce private absolute user paths or private product names as defaults.


