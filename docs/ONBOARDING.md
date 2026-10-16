# Onboarding

Run the plugin's registered Setup workflow after installation. It checks
amadeus_onboarding_status and seeds missing configuration with amadeus_setup.
The coordinator is bundled: a developer checkout is unnecessary. Node 24+ remains
a local prerequisite. Configuration and goals live under private Amadeus state
(normally local app data or existing AMADEUS_HOME); packaged defaults are copied
to runtime-config there. Existing goals and settings are never overwritten.
When upgrading or changing marketplace identity, use the dry-run-first durable
state migration workflow in [State migration](STATE_MIGRATION.md) so history
stays outside the versioned plugin cache. The optional checkout dependency
helper uses packaged setup and makes no privacy choice for the owner.

States are ready, setup incomplete and unavailable. Ready means backend files and
configuration are present; task preflight verifies execution readiness. Setup
does not start workers, collect inventory, send reports or check updates.

The setup skill explains quiet known dependency checks and independent optional
choices. See [Privacy onboarding](PRIVACY_ONBOARDING.md).

Approve **Start Amadeus automatically** in the host interface, then start a fresh
supported local chat. Verify Amadeus is available there and check onboarding
status. Starting Amadeus yourself outside the host does not prove approval.
Never edit trust records to bypass the host. Substantive tasks use the coordinator;
simple conversation stays lightweight. Say bypass Amadeus for this task to opt out.

Packages that start with a new chat currently support manual desktop installation,
including the GitHub marketplace, but not the public universal directory.
Web/mobile activation is outside this release. See the official
[packaging documentation](https://developers.openai.com/plugins/build/plugins).
No paid APIs or overages are enabled; local-model routing remains pilot-gated.

## Unattended run limits

Isolated Codex development workers run commands **without network access** by
default, and each worker run stops after 4 hours (`maximumRuntimeSeconds`).
To allow network access, for example for dependency installs, set
`"commandNetworkEnabled": true` in `runtime-config/worker-config.json` under
your Amadeus state folder.

Inside the sandbox, Codex development workers can read their project, but not:
- sibling projects;
- the Codex, Claude and Cursor login folders, or `.ssh`, `.aws` and similar credential folders;
- browser profiles, the app folders in `AppData\Roaming`, or Documents, Desktop, Downloads, Pictures and OneDrive.

Each run verifies this before any model call. Ordinary files elsewhere in your home folder, and
`AppData\Roaming\Microsoft` (which Windows itself requires), remain readable.
Run `npm run codex:sandbox-probe` from a checkout to recheck this on your machine without a model call.

Automatic continuation stops and asks you before continuing when a goal shows:
- 3 failed or blocked attempts in a row;
- 6 iterations in a row with no applied change; or
- 60 AI-worker calls in 24 hours (ordinary software steps don't count).

Answering that question starts a fresh set of attempts. To change the limits,
run `node src/coordinator.ts progress-limits --failure-limit <n> --idle-limit <n>
--daily-ai-calls <n>` from the packaged runtime.

Maintainer note: the host permission maps to the plugin `SessionStart` lifecycle
entry in `plugins/amadeus/hooks/hooks.json`.
