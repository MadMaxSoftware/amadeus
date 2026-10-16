# Durable state migration

Amadeus keeps goals, preferences, consent records, provider approvals and
qualification, and project continuity in a **per-user state root**. That root
lives outside the versioned plugin cache so marketplace identity changes and
plugin upgrades do not drop local history.

## Canonical root

Resolution order (highest first):

1. Explicit `--state-root` / API override
2. `AMADEUS_HOME`
3. Legacy internal coordinator home env (read-only compatibility)
4. Machine config `stateRoot` (normally under local app data `Amadeus/config.json`)
5. `<setupRoot>/coordinator-state` when that sibling already exists
6. Default: local app data `Amadeus/`

Machine config and lifecycle files under the state root are never shipped inside
the public plugin package.

## Workflow (dry-run first)

```bash
npm run amadeus:migrate-state -- inspect
npm run amadeus:migrate-state -- plan
npm run amadeus:migrate-state -- apply
npm run amadeus:migrate-state -- apply --execute
npm run amadeus:migrate-state -- verify --source-root <src> --target-root <dst>
npm run amadeus:migrate-state -- rollback --target-root <dst> --backup-id <id>
```

- **inspect** — read-only comparison of known Amadeus locations only
- **plan** — emit copy/skip/conflict actions without writing
- **apply** — defaults to dry-run; requires `--execute` to write
- **verify** — fingerprint allowlisted durable entries
- **rollback** — restore from migration backup metadata (dry-run unless `--execute`)

For non-database entries, conflict policy is `fail` (default), `keep-target`, or
`prefer-source` (backs up the target entry first). Database conflicts always
require consolidation. Single-root database migration uses SQLite `VACUUM INTO`
and logical verification; it never copies database/WAL/SHM files as a set.
Re-running a completed migration is idempotent.

If inspection finds more than one root containing a coordinator database,
automatic planning and cutover fail closed. Every history remains in place;
Amadeus will not guess which user's goals should win. Use a reviewed
consolidation workflow before changing machine configuration.

## Reviewed multi-root consolidation

Use explicit source roots; consolidation does not discover other directories.
An existing canonical database is automatically included as another source.
Planning reads each database in a SQLite read transaction and validates integrity,
foreign keys, the supported schema and the merged constraints in memory. It reads
only the durable artifact allowlist. Reports contain counts and opaque conflict
digests, never record contents, goal identifiers, artifact names or machine paths.

```bash
npm run amadeus:migrate-state -- consolidate --source-root <first> --source-root <second> --target-root <canonical>
```

Review the aggregate plan. Any conflict blocks execution. Only after every
coordinator using the target has stopped, run the same command with `--execute`,
`--offline`, and `--review-digest <inputDigest>` from the reviewed plan. Sources
remain in place. No configuration is changed, plugin is restarted or activated,
and no network operation runs. This milestone authorizes only synthetic execution;
the real histories must remain untouched until a separate cutover authorization.

Execution takes SQLite online-backup snapshots into a sibling transaction directory,
normalizes those snapshots to standalone DELETE-journal databases and verifies
their logical contents against the plan. Source artifact backups are also checked.
WAL/SHM files are never copied. Offline WAL-mode readers use immutable SQLite URIs
with file-change checks to avoid creating sidecars. Live WAL readers require
SQLite's normal read-only locking; the operator must provide existing WAL/SHM
access. Immutable mode is never used to ignore an existing WAL.

Conflict rules are deterministic and independent of source argument order:

- Identical records deduplicate. Disjoint goals, jobs, receipts, usage and approvals
  remain present. Event histories union by their full payload and are resequenced
  in timestamp order because independently allocated sequence numbers can collide.
- Active goals take priority over inactive variants. Associated jobs, usage and
  receipts follow the active source; otherwise an unambiguously newer timestamp
  wins. Missing/equal timestamps with differing contents fail closed.
- Losing variants are retained in the local `amadeus_consolidation_variants` table.
  The source snapshots retain every original row and its original numeric identity.
- Approval and setting differences always block; consolidation never implicitly
  restores consumed authority or grants consent. Idempotency-key collisions,
  unsupported tables/schema differences and failed constraints also block.
- Artifacts union by relative path. Identical files deduplicate. Conflicting goal
  package/run files follow active/newer goal priority and retain the losing bytes
  under `migration/artifact-variants/`. Other conflicting files block, including
  provider consent and registry files. Symbolic links/junctions are refused.
- Generated `software-runtime-homes` are deliberately excluded: they are
  disposable worker caches, may contain machine-specific runtime material, and
  are rebuilt when needed rather than copied into durable user history.

There is no automatic schema upgrade during consolidation. A schema mismatch is
an explicit unresolved conflict requiring reviewed schema normalization first.

## Consolidation rollback and interruption recovery

A sibling `.amadeus-consolidation-<opaque-id>/` holds the atomic journal, verified
source snapshots, staged root, and exact prior canonical root. Root publication
uses directory renames. The journal is flushed before publication; JSON writes
never fall back to non-atomic replacement. The transaction lock survives process
exit so a second process cannot guess that an unfinished transaction is abandoned.

```bash
npm run amadeus:migrate-state -- consolidation-recover --target-root <canonical>
npm run amadeus:migrate-state -- consolidation-rollback --target-root <canonical>
```

These commands default to dry-run. Execution requires `--execute --offline` after
the original consolidator and target coordinators have stopped. Recovery restores
the prior root after interruption, preserving staging/publication and all backups.
Rollback of a successful publication checks its complete fingerprint and refuses
if any file changed after cutover. For a newly created target, rollback preserves
the published root in the transaction directory and leaves the canonical path
absent. Repeated rollback and completed consolidation are idempotent. A retry after
rollback archives the entire old transaction rather than deleting its evidence.
This covers process interruptions and atomic file publication; filesystem or power
loss guarantees still depend on the underlying filesystem's rename durability.

## Legacy identifier audit and release decision

Executable Amadeus code always comes from the **packaged plugin runtime** unless
an explicit developer-mode opt-in passes repository identity and version checks.
Persisted `setupRoot` / `coordinatorRoot` values never select executable code on
public installs; they remain non-authoritative migration hints only.

The former host-specific setup-root alias stays removed from active layout discovery.
The legacy internal coordinator-home environment variable and former app-data
folder identifier remain confined to reading existing local durable state.
`<legacySetupRootHint>/coordinator-state` sibling lookup remains a compatibility
reader for goals/history. Public defaults use the canonical per-user Amadeus
root and Amadeus product identity. See `docs/LEGACY_COUPLING_AUDIT.md`.
Privacy scanners retain their detection patterns, and historical release notes
remain historical evidence. No legacy product name or host-specific setup path
is a public default or self-repair target.

Keep the current version unchanged for this repository milestone. Recommend a
subsequent patch release only after the full public-safety/package suites and the
aggregate-only dry-run of both known histories pass (or identify a reviewed exact
conflict), followed by separate release authorization. Synthetic success alone is
insufficient evidence for real-state cutover or a release.

For an aggregate-only artifact handoff, run `consolidate` on the authorized local
artifact host with exactly the two already-known source roots and a nonexistent
`--target-root` beneath the project's ignored `verification/` directory. Omit
`--execute`, `--offline`, `--report`, and any configuration options. This reads
only those histories and their allowlisted artifacts and does not create the
target, backups, journals or configuration. Return only the aggregate JSON plan.
Do not use `inspect` for this handoff, because inspection probes additional known
legacy locations. A restricted worker cannot certify this check without access
to both authorized roots; synthetic fixtures cannot substitute for that evidence.

## Journal and backups

Under `<stateRoot>/migration/`:

- `journal.json` — status, actions, backup id, rollback metadata
- `schema-journal.json` — state schema version and relative lifecycle paths
- `backups/<backup-id>/` — pre-replace snapshots for conflict-safe recovery

## Public trust

- Reports redact absolute paths and never include goals, prompts, secrets, or
  hardware inventory.
- Synthetic fixtures cover persistence across version/cache identity changes,
  idempotency, backup/rollback, collisions, and package exclusion.
- Do not commit machine config, SQLite ledgers, or migration backups.

## Cursor configuration recovery during setup

Packaged setup preserves a detected host-specific Cursor configuration. When the
runtime destination is missing or still equals the shipped disabled template,
setup checks the saved legacy setup hint for a complete browser-login containment
configuration. Template comparison ignores JSON property order. Reconfiguring
state without a new setup root retains the saved hint; it never grants that hint
executable runtime authority. File and directory bindings must have the expected
types. Incomplete candidates do not enable Cursor, and owner-edited destinations
are preserved. Dependency installation also runs this idempotent repair when the baseline runtime is already ready; unchanged packaged machine settings and ready developer configurations are retained.

Migrated configurations use the packaged isolation acceptance and security-state
helpers. Host paths and credentials stay in private machine state, outside Git.
The public disabled template remains the safe default for machines without a
working Cursor installation. A migration is not proof of live isolation: regenerate
workspace-bound read/write receipts and run a bounded isolated canary before
claiming Cursor verification. Never substitute fixture results for those receipts.