# Development status after v0.3.4

## Iteration 46 Claude Code marketplace host integration

Claude host packaging now stages an official local marketplace
(`amadeus` → `./amadeus`) and drives `claude plugin marketplace add`,
`install --marketplace`, `enable`, and `list` through the lifecycle adapter and
`scripts/claude-live-host-canary.mjs`. Claude-as-worker stays optional and out
of host acceptance. Live signed-in probes under isolated `CLAUDE_CONFIG_DIR`
verified: marketplace add ok; install ok; `plugin list --json` shows
`amadeus@amadeus` enabled; session loads plugin source
`amadeus@amadeus` with `/amadeus:amadeus|maestro|setup`; MCP
`plugin:amadeus:amadeus` connected; SessionStart dispatch observed; same-engine
hook/MCP/runtime/skill hashes match the shared Codex runtime. Git-bash hook
execution can still fail inside the app sandbox (`NtCreateDirectoryObject`)
even though the SessionStart script succeeds via Node — reported honestly in
the canary. Full suite 134/134, packaged 13 pass/1 skip, Claude host 13/13,
public-safety/privacy clean, workspace-diff-check clean. This sandbox cannot
mutate `.git` (`getcwd` blocked + index EPERM), so the milestone commit is
packaged as an origin-host handoff. Codex behavior is unchanged.

Housekeeping: examined=build-claude-package,claude-host-lifecycle,live host canary,sandbox runners,package scripts,claude package/host tests,CLAUDE_CODE/HOST_COMPATIBILITY/VALIDATION/DEVELOPMENT_STATUS,parity fixture,runtime package scripts; removed_or_quarantined=none; preserved=historical inert Claude fixture,Codex wrapper/default routes,optional worker canaries,verification/ evidence (gitignored),unrelated paths

## Iteration 45 direct-preflight sandbox path and checkpoint handoff

Restricted Windows workers now have stdin-piped Claude host preflight and
canary runners (`claude:host-preflight:sandbox`, `claude:host-canary:sandbox`)
so dependency probes no longer require Node to realpath a script under `C:\\`.
Universal verification prefers `scripts/workspace-diff-check.mjs` over native
`git diff --check` when the sandbox runner is present, avoiding a hard stop
when Git getcwd is blocked. Packaged and reporting sandbox runners keep child
Node under repository short-circuit hooks. When `.git` mutation is denied,
`scripts/local-checkpoint-handoff.mjs` packages an origin-host commit handoff
with exact file bytes and hashes; it never writes `index.lock` and never
pushes. A worker-local Claude Code 2.1.300 binary passed host preflight and
plugin-command probes; `claude auth status` reported `loggedIn=false`, so the
canary outcome is honest not-signed-in and the support matrix stays candidate.
Focused Claude/host/handoff tests: 10 passed. Package gate: 12 passed, 1 link
fixture skipped. Full repository suite: 133 passed. Migration 10/10,
consolidation 18/18, reporting 27/27, public-safety/privacy clean,
workspace-diff-check clean.

Housekeeping: examined=claude preflight/canary sandbox runners,spawn-repo-module,packaged/reporting sandbox runners,verification-checks direct integrity path,local checkpoint handoff,package scripts,validation docs,claude host tests,compatibility contract; removed_or_quarantined=none; preserved=historical inert Claude fixture,existing Codex behavior,support matrix candidate row,unrelated paths,.worker-isolation.json

## Iteration 44 Claude host lifecycle and signed-in adapter

The shared engine now includes a Claude Code host lifecycle adapter
(`scripts/claude-host-lifecycle.mjs`) for install/update/rollback/disable/
uninstall with dependency preflight, plus a separately authorized
`claude-subscription-signin` worker adapter/driver. Default Codex routing is
unchanged; Claude is opt-in, suggested, or fallback-only when available.
Focused Claude validation passed 10 tests (1 junction subtest skipped). The
version-bound canary reported Claude CLI absence honestly with
`supportClaim=false`. The full declared repository suite passed 133 tests.
Runtime packaging now includes 47 files. Live signed-in Claude host/SessionStart/
MCP/E2E evidence remains required before matrix promotion beyond candidate.

Housekeeping: examined=canonical assets,host fixtures,shared runtime identity,host lifecycle scripts,signed-in adapter/driver,work routing,supervisor wiring,lifecycle version reader,package scripts,compatibility contract,roadmap,validation guidance,parity fixture,spawn sandbox helper; removed_or_quarantined=none; preserved=historical inert Claude fixture,existing Codex wrapper and default routes,canonical skills,local state and history

## Iteration 43 isolated package gate

The isolated worker reran the fresh temporary-checkout package gate after the
Windows manifest repair: 11 canonical assets and 42 runtime files verified,
and all 10 package tests passed. The clean-machine install and upgrade fixture
passed. Public-safety scanned 205 files and privacy scanned 74 files, with no
findings. `npm run workspace-diff-check` and `git diff --check` passed before
this status update. The owner-supplied authoritative reporting result remains
25 of 25 tests passed, including the 769-goal case. This worker has no verified
write access to the authoritative checkout, so authoritative patch application
and its independent fresh-checkout gate remain coordinator work. The roadmap
backlog below identifies no further owner-free runtime repair on this evidence.

Housekeeping: examined=package builder,canonical assets,generated wrapper,manifest,package fixture,clean-machine fixture,public-safety inputs,privacy inputs,development status,roadmap; removed_or_quarantined=none; preserved=v0.3.4 release evidence,private state,unrelated paths

## Iteration 42 package and roadmap reconciliation

The isolated worker snapshot contains the Windows line-ending manifest repair.
The fresh temporary checkout package gate verified 11 canonical assets and 42
runtime files, then passed all 10 package and release tests. The clean-machine
fixture passed, public-safety and privacy scans found no findings, and the
workspace diff check passed. The owner separately supplied an authoritative
checkout reporting run: all 25 tests passed, including the 769-goal mixed
recovery case. These results establish the tested package and recovery paths;
the coordinator still must independently apply and verify this worker patch in
the authoritative checkout before treating this checkpoint as integrated.

The criterion backlog below leaves no evidenced owner-free runtime repair.
Installed marketplace activation and desktop presentation need a separate host
action. The first cross-host pilot gate is a consented Claude Code local pilot
against the eight checks in `docs/HOST_COMPATIBILITY.md`; its fixture is inert
and no support claim is enabled. Stable automatic local-model routing remains
closed pending the separately consented friend-machine gate in
`docs/LOCAL_MODEL_PILOT.md`.

Housekeeping: examined=package builder,canonical assets,generated wrapper,manifest,package fixture,release tests,clean-machine fixture,reporting evidence,README,charter,roadmap,host compatibility,local-model pilot,development status; removed_or_quarantined=none; preserved=v0.3.4 release evidence,private state,unrelated paths

## Iteration 41 Windows package manifest reconciliation

The isolated Windows checkout exposed a package gate failure before any patch
was applied: Git had checked text assets out with CRLF, while the committed
canonical manifest contained hashes of LF content. The agent package builder
now hashes the LF form of each text asset and accepts either line ending in
the manifest file. It still compares the source and generated wrapper asset
bytes directly, so drift remains a failure. A package test converts all 11
assets and their generated counterparts to CRLF and verifies that the manifest
remains valid. The sandbox build regenerated the manifest and verified all 42
runtime files; the independent package gate passed 10 tests. The focused
reporting suite passed 25 tests, the clean-machine fixture passed, and public
safety found no findings. The owner-supplied authoritative-host reporting run
remains separate evidence.

This closes the observed Windows checkout package failure. Installed desktop
activation, non-OpenAI host parity, and friend-machine local-model routing
remain subject to their documented consent and pilot gates.

Housekeeping: examined=agent package builder,canonical assets,generated Codex wrapper,manifest,package fixture,release tests,development status,roadmap; removed_or_quarantined=none; preserved=v0.3.4 release evidence,private state,unrelated paths

## Iteration 38 static Claude Code parity fixture

Added an incomplete, inert Claude Code wrapper fixture with manifest, MCP, and
SessionStart mappings. A focused test checks version and canonical asset
relationships. It contains no runnable scripts or skills and has not been
installed, enabled, or piloted. The remaining live checks are enumerated in
`host-fixtures/claude-code/parity.json` and require a separately consented local
pilot. The Codex wrapper remains the only generated, packaged host runtime.

Housekeeping: examined=canonical assets,Codex wrapper,package scripts,host compatibility,public-safety inputs; removed_or_quarantined=none; preserved=v0.3.4 release evidence,0.3.5 runtime,private state,unrelated paths

This is a criterion-level backlog for the public roadmap. A passing source test
does not by itself prove desktop host behavior or authorize a release.

| Criterion | Current evidence | Remaining gate |
| --- | --- | --- |
| Public v0.3.4 runtime authority | `docs/RELEASE_NOTES_0.3.4.md`; packaged runtime and migration tests | Keep regression checks in every package change |
| Clean packaged install | `npm run test:clean-machine:sandbox` tests first setup from a copied plugin with no tool discovery; `npm run test:packaged:sandbox` verifies all 42 rebuilt runtime files and runs eight release tests, including plugin-only setup and backend status | Installed marketplace activation and fresh desktop chat require an approved host action |
| Upgrade without loss | The clean-machine test repeats setup after writing private goals and owner configuration; state migration and consolidation tests cover older roots; the package gate verifies source/runtime agreement | An installed-host marketplace upgrade and restart need separate approval |
| Privacy on first run | Onboarding and public-trust tests cover declined consent, no automatic discovery, and read-only status | Continue privacy and public-safety gates on future changes |
| Owner progress and provider attribution | Completion-reporting tests cover a newly queued job, a running job with heartbeat but no new work, an interrupted worker, a completed task with outstanding human action, and mixed provider usage. The server self-test contains routed-step and task-end Cursor attribution assertions. Source and plugin runtime use the same reporting server. | Full server self-test reached a Windows sandbox rename denial in its background-run fixture; installed-host chat presentation remains subject to the separately approved activation gate |
| Amadeus and Maestro alias consistency | Maestro is packaged as a direct alias for Amadeus with the same instructions, behavior, and engine. Branding tests reject separate-voice drift. | Live owner chat presentation remains subject to the separately approved activation gate |
| Isolation, patch integrity, recovery, performance | Patch application sends receipt-verified bytes to Git. Manifest source validation and workspace materialization reject linked parent directories and linked files. On 2026-10-14 the owner ran `npm run test:worker-isolation:sandbox` on the junction-capable origin host: both linked-parent rejection and regular nested-directory acceptance passed, with no skips. Recovery tests cover late heartbeat, claim-time expiry, emergency stop through two database reopens, atomic reconciliation after an injected failure with 500 goal events, and atomic expiry of 12 independent leases after an injected mid-batch failure and restart. A 360-candidate queue fixture checks project conflicts and claim latency; a separate 240-goal fixture verifies durable state and events after reopening. The 769-goal mixed fixture passed in both the isolated worker and authoritative checkout; the latter ran all 25 reporting tests without failure or skip. | These bounded fixtures establish the tested behavior, not an unbounded cross-machine performance guarantee. Continue to investigate any concrete new failure evidence. |
| Local-model routing | `docs/LOCAL_MODEL_PILOT.md` defines the public gate | A separately consented, approved friend-machine pilot is required before stable routing |

The repository snapshot reports version 0.3.5 in `package.json` and the plugin
manifest. The v0.3.4 release notes remain the published baseline evidence for
the long-haul stream; a development snapshot or test result does not publish a
new release.

## Iteration 37 canonical package checkpoint

The isolated worker now holds 11 declared canonical assets under
`agent-package/`. The generator verifies version, MCP and startup entrypoints,
asset bytes, and a SHA-256 manifest for the Codex wrapper. Executable
coordinator scripts and the 42-file packaged runtime remain shared with the
existing Codex plugin, without a second executable copy in the canonical tree.
The sandbox package gate passed nine tests, including drift and version mismatch
cases; public-safety found no findings, and the workspace diff check passed.
This establishes deterministic package fidelity for Codex only. It does not
establish installation or behavior on another host.

Housekeeping: examined=canonical assets,generated Codex wrapper,plugin scripts,packaged runtime,package scripts,release tests,README,charter,roadmap,host compatibility,privacy and public-safety inputs; removed_or_quarantined=duplicate canonical runtime scripts,temporary seeding script; preserved=v0.3.4 release evidence,0.3.5 coordinator runtime,private state,unrelated paths

## Iteration 34 authoritative-host recovery profile

The owner ran `npm run test:reporting:sandbox` in the authoritative checkout on
2026-10-14. It exited 0: 25 tests passed, none failed or skipped, in
8768.4542 ms. The 769-goal mixed recovery fixture passed along with the full
reporting and recovery suite. Recorded mixed-load timings were claim 117.216 ms,
rollback 7.569 ms, reopen 11.928 ms, and expiry 12.729 ms. This resolves the
specific origin-host evidence gap below. The earlier worker timings remain
separate observations; neither run is a general performance promise. No new
runtime failure is established by these results.

The 0.4 package foundation now declares 11 canonical assets under
`agent-package`, generates a version-matched Codex wrapper and hash manifest,
and checks byte fidelity, drift, and version mismatch. The package gate also
checks 42 runtime files. The later host claims
require external actions: installed marketplace activation and desktop restart
for presentation, a consented non-OpenAI host parity pilot for 0.4, and a
separately consented friend-machine pilot before stable local-model routing in
0.5. This checkpoint does not authorize installation, provider enablement, or
publication.

Housekeeping: examined=reporting fixture,package scripts,development status,roadmap,local-model pilot gate; removed_or_quarantined=none; preserved=release history,private state,unrelated paths

## Iteration 36 post-drift housekeeping disposition

At that checkpoint, the active worker snapshot contained the 0.3.5 Codex package and the 0.4
compatibility contract. The proposed `agent-package` tree and its build and
test scripts were absent; they were added in the subsequent package foundation.
The existing plugin runtime manifest,
SessionStart hook, package build and sandbox test scripts remain the only active
package path. None is redundant on the evidence available, so this audit makes
no runtime or configuration deletion. The prior authoritative-host 25-test
reporting result remains evidence for the recovery fixture, not for the future
canonical package. Historical release notes and local state are preserved.

Housekeeping: examined=source package boundary,root and runtime package scripts,plugin manifest,SessionStart hook,build and sandbox scripts,release and package tests,README,charter,roadmap,host compatibility,development status,workflow,configuration templates,environment inputs; removed_or_quarantined=none; preserved=v0.3.4 release evidence,0.3.5 Codex runtime,private state,unrelated paths

## Iteration 33 host-profile attempt and worker comparison

The origin checkout again returned `Access is denied` on a read-only `cd /d`
attempt from this restricted worker, so an independent authoritative-host
profile could not run here. The unchanged 769-goal fixture passed on the worker
with 25 tests, no failures, and no skips. Its claim, rollback, reopen, and
expiry timings were 147, 8, 11, and 14 ms (rounded), compared with the prior
worker runs of 148/8/12/14 and 151/8/11/13 ms. The fixture again verified
atomic rollback across restart, one expiry per lease on retry, and conflict
blocking until reconciliation. These measurements show no reproduced worker
regression; they do not establish origin-host latency. The owner-supplied
junction-capable origin-host isolation result remains separate evidence.

The restricted-worker package gate verified 42 runtime files and eight release
tests. Public-safety and privacy scans found no findings, and the workspace
diff check passed. No source or packaged runtime change was warranted.

Housekeeping: examined=coordinator queue and expiry paths,reporting fixture,package scripts,development status; removed_or_quarantined=none; preserved=release history,private state,unrelated paths


## Iteration 32 mixed-profile rerun

The same 769-goal fixture passed on this isolated worker: 25 reporting tests
passed with no failures or skips. It again verified atomic rollback across
restart, one expiry per lease on retry, and project conflicts held until
reconciliation. Timings were claim 151 ms, rollback 8 ms, reopen 11 ms, and
expiry 13 ms, compared with the previous worker measurements of 148, 8, 12,
and 14 ms. These small differences are single-run variation, not evidence of
a runtime regression. A read-only attempt to enter the named origin checkout
from this restricted invocation returned `Access is denied`; therefore this
run does not establish an independent authoritative-host profile. The owner's
separate junction-capable host result remains valid for the linked-parent
isolation fixture only.

Housekeeping: examined=coordinator queue and expiry paths,reporting fixture,package scripts,development status; removed_or_quarantined=none; preserved=release history,private state,unrelated paths

## Iteration 31 mixed recovery and queue profile

A 769-goal mixed fixture holds 48 leased jobs, queues 720 conflicting
descendants, and leaves one independent job claimable. On this worker host,
the free claim took 148 ms. An injected failure during expiry rolled the
whole batch back in 8 ms; reopening took 12 ms, and successful expiry took
14 ms. After restart, all 48 jobs and goals retained their pre-expiry state
with no expiry events. Retry marked each uncertain exactly once, kept
conflicting descendants blocked, and allowed a descendant only after its
predecessor was reconciled. These are one-host measurements, not a public
performance guarantee. No production regression was reproduced.

Housekeeping: examined=coordinator queue and expiry paths,reporting fixtures,packaged runtime,package scripts,development status; removed_or_quarantined=none; preserved=release history,private state,unrelated paths

## Iteration 30 batch recovery and broader loads

The reporting integration suite now injects a database failure midway through
expiring 12 independent leases. After reopening the database, all 12 jobs and
goals retain their pre-expiry state and none has an expiry event. Removing the
fault lets one retry expire every lease exactly once. Conflicting replacement
work stays blocked until its predecessor is explicitly reconciled. The queue
fixture now covers 360 conflicting candidates and the reopen fixture covers
240 durable goals. Their five-second assertions are bounded local regression
checks, not cross-machine performance promises. The reporting suite passed 24
of 24 tests. No production failure was reproduced, so no runtime repair was
needed.

Housekeeping: examined=coordinator expiry and claim paths,reporting integration tests,packaged runtime,package scripts,development status; removed_or_quarantined=none; preserved=release history,private state,unrelated paths

## Iteration 27 claim recovery and queue load

The claim path previously queried running and uncertain jobs for every queued
candidate. It now reads occupied project roots once inside the same claim
transaction. A 120-conflicting-candidate fixture selected the first free
project in 283 ms on this worker. This is a representative local measurement,
not a cross-machine performance guarantee. A separate integration case proves
claim expires a stale worker before replacement dispatch, marks its goal and
job uncertain, and records one expiry event. The reporting suite passed 20 of
20 tests. The package build and gate verified 42 runtime files and passed eight
release tests. `workspace-diff-check` and `git diff --check` passed.

Housekeeping: examined=coordinator claim and lease expiry,reporting recovery tests,packaged runtime,package manifest,development status; removed_or_quarantined=none; preserved=release history,private state,unrelated paths

## Iteration 29 interrupted reconciliation and larger history

Reconciliation previously changed the uncertain job before changing its goal and
events, so an interruption could leave a partially reconciled record. It now
uses one database transaction. The integration fixture injects a database
failure during the goal update after adding 500 goal events, reopens the
database, verifies the job and goal remain uncertain with no reconciliation
event, then completes reconciliation. The focused reporting suite passed 23
tests. The existing 120-goal and 120-candidate fixtures continue to cover
durable state and queue claim behavior. These are representative local loads,
not a cross-machine performance guarantee.

Housekeeping: examined=coordinator reconciliation,reporting integration tests,packaged runtime,package manifest,development status; removed_or_quarantined=none; preserved=release history,private state,unrelated paths

## Iteration 28 stop and restart recovery

The reporting integration fixture now stops a running worker, rejects its next
heartbeat, reopens the database, acknowledges the stopped worker, and confirms
that conflicting work remains undispatchable through another reopen. Explicit
failed reconciliation releases the project boundary and permits replacement
dispatch. A separate 120-goal fixture verifies unique goal records and durable
events after reopening. The reporting suite passed 22 tests. The package gate
verified 42 runtime files and passed eight release tests; `workspace-diff-check`
and `git diff --check` passed. Larger histories and interrupted reconciliation
remain open performance and recovery evidence.

Housekeeping: examined=coordinator stop and reconciliation,reporting integration tests,packaged runtime,package manifest,development status; removed_or_quarantined=none; preserved=release history,private state,unrelated paths

## Iteration 26 expired-lease recovery

The integration path showed a reproducible gap: a heartbeat arriving after its
lease expired could renew a still-running job before `expireStale` classified
it. Heartbeat now checks expiry and classifies stale work inside the same
database transaction as renewal. The late-heartbeat fixture verifies rejection,
an uncertain job and goal, and exactly one expiry event. The focused reporting
suite passed 18 of 18 tests. The package build and package gate verified 42
runtime files and passed eight release tests; `workspace-diff-check` and
`git diff --check` passed. This closes the observed lease recovery case, not
the wider recovery and performance criterion.

Housekeeping: examined=coordinator heartbeat and lease expiry,reporting integration tests,packaged runtime,package manifest,development status; removed_or_quarantined=none; preserved=release history,private state,unrelated paths

## History and package-gate reconciliation

This isolated worker has a single synthetic snapshot commit (`094a313`) and no
configured Git remote. The GitHub CLI is unavailable, and the public repository
pull-request and release URLs were not retrievable from this worker. Open PRs,
merge history, and remote release state therefore remain unverified here; the
published v0.3.4 baseline is the supplied prior verification, not a fresh remote
claim. Do not infer that there are no open PRs.

The restricted-worker package gate copies the current source, plugin, package
metadata, build script, and release test into a temporary fixture. This avoids
Node realpath denial on the worker parent while checking the actual packaged
runtime byte for byte before running release behavior tests. The fixture clears
`AMADEUS_WORKER` so the first-run hook test evaluates an owner session. Use
`npm run amadeus:build:sandbox` to rebuild the package in the same restriction;
the regular `test:packaged` remains the host-side equivalent.

Housekeeping: examined=package scripts,packaged runtime,release tests,clean-machine tests,development status; removed_or_quarantined=none; preserved=release history,private state,unrelated paths

## Owner reporting checkpoint

The current job now starts with its own first-checkpoint message. A previous
job's completed step cannot appear as current progress while the new job only
renews its lease. Heartbeats remain liveness evidence, not completed work.
Live and task-end allocation use the provider recorded on each completed routed
step. Cursor's model is shown only when a step recorded it; an unrecognized
provider retains its recorded name instead of being labeled Codex. Percentages
still mean shares of completed routed steps, not time or money saved. The
restricted-worker reporting fixture runs the focused tests where Node cannot
resolve the workspace parent directory.

The full server self-test reached `EPERM` while renaming a background-run state
file in the Windows sandbox temporary directory. This is an environment failure
after the reporting assertions, not a passing full self-test result. The
focused reporting tests and package release tests passed separately.

Housekeeping: examined=reporting server,coordinator event records,reporting tests,package scripts,README,roadmap,development status; removed_or_quarantined=none; preserved=release history,private state,unrelated paths

## Isolation source-path checkpoint

Manifest validation and materialization now inspect every source path component
with `lstat` before reading or copying. This rejects linked parent directories,
including Windows junctions, and keeps the final file requirement. The focused
fixture verifies regular nested paths. This worker's Windows sandbox denied
junction creation, so the linked-parent fixture skipped; a host that permits
junction creation must run it before treating the isolation milestone as fully
verified. Package parity and the eight packaged release tests passed.

Housekeeping: examined=worker isolation source,packaged worker isolation,manifest source test,package verification list,development status; removed_or_quarantined=none; preserved=release history,private state,unrelated paths

## Iteration 22 host and recovery evidence

This isolated Windows worker still cannot create a junction. The focused
linked-parent test skipped with `EPERM`, and an independent `mklink /J` probe
returned `Access is denied.` A junction-capable host must run the fixture;
this worker cannot provide that evidence. The disposable probe directory was
removed.

The available repository evidence describes recovery and performance as
remaining work but contains no captured failing recovery or performance case
to reproduce. The focused reporting suite passed all 17 tests, including
stalled-worker, technical-block, and preserved-iteration recovery. The package
gate verified 42 runtime files and passed eight release tests. The workspace
diff check was clean. These checks support the current behavior but do not
establish that the broader recovery or performance milestone is complete.

Housekeeping: examined=worker isolation source,packaged runtime,reporting recovery tests,release tests,package scripts,development status; removed_or_quarantined=none; preserved=release history,private state,unrelated paths

## Iteration 23 linked-parent host check

The linked-parent fixture still skipped because junction creation returned
`EPERM`. Independent `mklink /J` returned `Access is denied`, and `mklink /D`
reported insufficient privilege. The disposable probe directory was removed.
This worker cannot supply junction-capable host evidence; the fixture still
needs to run on such a host. No failing recovery or performance case was
captured, so there is no evidence-based code fix in this iteration.

The recovery reporting suite passed 17 of 17 tests. The package gate verified
42 runtime files and passed eight release tests. `workspace-diff-check` and
`git diff --check` passed before this documentation update. These checks do
not close the linked-parent or broader recovery and performance criteria.

Housekeeping: examined=worker isolation source,linked-parent fixture,packaged runtime,reporting recovery tests,release tests,package scripts,development status; removed_or_quarantined=none; preserved=release history,private state,unrelated paths

## Iteration 25 host evidence reconciliation

The owner supplied the origin-host result for the junction-capable fixture on
2026-10-14: `npm run test:worker-isolation:sandbox` exited 0 with two tests
passed, none failed, and none skipped. The cases were `manifest source
validation rejects linked parent directories` and `manifest source validation
accepts regular nested directories`. This closes the specific host-evidence gap
recorded in iterations 22 and 23. It does not establish a fresh installed-host
activation, recovery failure reproduction, or performance benchmark.

Housekeeping: examined=worker isolation fixture,development status,roadmap; removed_or_quarantined=none; preserved=release history,private state,unrelated paths
