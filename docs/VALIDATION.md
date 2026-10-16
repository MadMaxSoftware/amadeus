# Validation

## Milestone order and host parity

The 0.4 series covers cross-host portability; qualified stable local-model
routing moves to 0.5 and remains gated by `docs/LOCAL_MODEL_PILOT.md`.
`docs/HOST_COMPATIBILITY.md` is the canonical host parity checklist and
candidate evidence matrix. Official host documentation is design evidence only:
no new host is supported until a pinned local pilot passes every gate.
Claude Code is the first planned non-OpenAI pilot. Web/mobile surfaces lacking
local hooks/runtime cannot pass the full-support gate.

Claude candidate and marketplace staging are covered by
`test/claude-package.test.mjs` in the package gate. Host lifecycle and
signed-in worker adapter checks are covered by `npm run test:claude-host` /
`test:claude-host:sandbox`, plus `npm run claude:host-canary` /
`claude:host-canary:sandbox` for an honest version-bound availability report.
`npm run claude:live-host-canary` / `claude:live-host-canary:sandbox` drives the
documented marketplace/install/enable/list flow against the local signed-in
Claude Code CLI under a reversible config scope and records SessionStart /
same-engine evidence. Claude-as-worker remains optional. Restricted sandboxes
must use the `:sandbox` stdin-pipe scripts because direct `node scripts/...`
realpath fails when `lstat('C:\\')` is denied. When a worker cannot mutate
`.git`, `scripts/local-checkpoint-handoff.mjs` packages an origin-host commit
handoff instead of claiming a local Git checkpoint. See `docs/CLAUDE_CODE.md`
for the user flow and remaining origin-host gaps. Host implementations must
repeat the full packaged and repository tests before a support claim.

Marketplace path:

```bash
codex plugin marketplace add MadMaxSoftware/amadeus
codex plugin marketplace list
codex plugin marketplace upgrade amadeus
```

Local candidate checks (from a development checkout):

```powershell
npm run amadeus:privacy
npm run public-safety
npm run test:amadeus
npm run amadeus:self-test
npm test
```

On restricted Windows sandboxes that deny `lstat('C:\')` during Node
`file:` realpath (or when a host injects `NODE_OPTIONS=--require` under `C:\`),
use the stdin-piped runners instead of direct `node --test <file>`. The sandbox
npm scripts clear `NODE_OPTIONS` before starting Node:

```powershell
npm run test:branding:sandbox
npm run test:updates-providers:sandbox
npm run test:verifier-discovery:sandbox
npm run test:state-migration:sandbox
npm run test:state-consolidation:sandbox
npm run test:clean-machine:sandbox
npm run amadeus:privacy:sandbox
npm run public-safety:sandbox
```

To run every test declared by `npm test` in a restricted Windows worker, use
this command from the repository in `cmd.exe`:

```text
set NODE_OPTIONS=&& (type scripts\run-full-tests-sandbox.mjs | node --input-type=module)
```

This runner loads the original test files using repository-scoped module hooks
and stores temporary fixtures in the writable workspace. It avoids the sandbox
temporary directory's atomic-rename restriction without changing production
publication logic or replacing tests with approximations.

If `npm` itself cannot start because of an injected `NODE_OPTIONS`, clear it
in the current shell first, then run the sandbox script:

```powershell
$env:NODE_OPTIONS=''
npm run test:updates-providers:sandbox
```

Coordinator verification prefers these sandbox runners automatically when
`scripts/run-*-tests-sandbox.mjs` exists for a changed test file (or when
`package.json` `coordinator.verify` lists the sandbox npm scripts). The npm
wrappers use the Windows command shell's `type` pipe because a nested
PowerShell process may lose the isolated worker directory. The normal
`public-safety` command remains the release check; `public-safety:sandbox`
runs both scans in that restricted environment.

Optional when packer scripts exist in the checkout:

```powershell
python scripts/pack-public-release.py
python scripts/prepare-github-repo-candidate.py
python scripts/simulate-clean-machine.py
```

Checks covered:

- Branding / marketplace relative paths / Maestro skill
- Startup permission plain-language title/description (`Start Amadeus automatically`)
  and adjacent setup/onboarding wording (`test:branding:sandbox`,
  `test/amadeus-branding.test.mjs`)
- Public install/update commands for `MadMaxSoftware/amadeus`
- Privacy scan (no personal paths, private project names, secrets, receipts, credentials)
- Public-trust policy, declared network-flow enforcement, off-by-default
  consent, loopback-only routing, and local support-bundle redaction
  (`test/amadeus-public-trust.test.mjs`)
- Consent-based update check/stage/approve/rollback cases
  (`test/amadeus-updates-providers.test.mjs`)
- Consent-based loopback provider discovery, registry, qualification, isolation
- Stable-channel local-model pilot gate remains closed
- Missing-Cursor fallback to ordinary software + Codex/GPT routes
- Config migration and clean-machine fallback without local providers
- Durable state-root migration dry-run/apply/verify/rollback with synthetic fixtures
  (`npm run test:state-migration:sandbox`, `docs/STATE_MIGRATION.md`)
- Clean-machine simulation without a private setup tree (when packer present)
- Packaged first install and repeat upgrade in a temporary clean checkout,
  preserving private goals and edited configuration without provider discovery
  (`test:clean-machine:sandbox`)

## Alias and Cursor recovery verification (2026-10-14)

Maestro's canonical skill and generated plugin skill delegate to the same Amadeus
behavior. Both branding test entrypoints now enforce that alias contract; the
obsolete sandbox assertions for a separate presentation style were removed.
Onboarding regression tests cover reordered disabled templates, retention of the
migration hint across reconfiguration, invalid file/directory bindings, and
preservation of owner-edited Cursor settings.

The full Node test suite passed 131 tests with no failures or skips using Node's
preserve-symlinks flags for the restricted worker path. The sandbox packaging,
reporting, migration, consolidation, runtime-authority, clean-machine, provider,
verifier-discovery, branding, privacy/public-safety, and workspace-diff gates also
passed. Worker-isolation source checks passed the regular-directory case; the
junction case was skipped because this worker cannot create junctions. Historical
origin-host junction evidence remains recorded in DEVELOPMENT_STATUS.md.

Live Cursor verification then passed on the origin host with Cursor Agent
`2026.09.18-9a7762b`. The first generic-harness attempt exposed an ordering bug:
the harness created its untracked probe files before `verifyWorkspace` checked
that the isolated repository was clean. The repaired harness validates and builds
the launch while the repository is pristine, then creates the disposable probes.
All containment checks passed, including project read/write, unapproved and
source-write denial, protected and parent-path denial, Git and receipt protection,
runtime-directory isolation, and workspace restoration. A bounded browser-login
model canary returned `CANARY_OK` with exit 0, no timeout or stderr, and the worker
repository remained clean afterward. Private configurations, receipts, and attempt
artifacts remain outside Git.
