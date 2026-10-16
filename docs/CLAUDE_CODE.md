# Claude Code host integration

Status: Published in Amadeus 0.4.1. The public GitHub repository is a Claude
Code marketplace containing a generated Claude host plugin backed by the same
shared Amadeus engine as Codex. Marketplace install/enable/SessionStart evidence
is collected with the signed-in Claude Code CLI under a reversible isolated
config scope. Claude-as-an-Amadeus-worker remains optional and is not required
for host-plugin compatibility. The existing Codex wrapper and default routing
remain unchanged.

## User install flow

Install directly from the public repository:

```text
claude plugin marketplace add MadMaxSoftware/amadeus
claude plugin install amadeus@amadeus
claude plugin list --json
```

Restart Claude Code or run `/reload-plugins`, then invoke `/amadeus:setup`.
Use `claude plugin update amadeus@amadeus` for later marketplace releases.

Claude Desktop and Claude Code use the published Amadeus marketplace package.
Existing marketplace installations receive updates through the host's normal
marketplace flow; no separate desktop ZIP upload is required. Skills work in
Chat, Cowork, and Claude Code; the local MCP server and SessionStart hook run in
Cowork and Claude Code, not ordinary Chat.

The marketplace layout is:

```text
repository/
  .claude-plugin/marketplace.json
  claude-plugin/           # generated Claude candidate (no .codex-plugin)
    .claude-plugin/plugin.json
    hooks/hooks.json       # SessionStart -> session-start.mjs
    skills/...
    scripts/server.mjs
    runtime/...            # shared Amadeus engine
```

Inside a Claude Code session the user-facing skill/commands are
`/amadeus:amadeus`, `/amadeus:maestro`, and `/amadeus:setup`. SessionStart loads
the same packaged hook used by the Codex package (host path variable translated
to `${CLAUDE_PLUGIN_ROOT}`).

## Developer verification

```text
npm run amadeus:build
npm run test:packaged
claude plugin validate .
node scripts/claude-host-lifecycle.mjs preflight
node scripts/claude-host-lifecycle.mjs stage-marketplace --destination <new-marketplace-directory>
npm run test:claude-host
npm run claude:host-canary
npm run claude:live-host-canary
```

On restricted Windows sandboxes that deny `lstat('C:\\')` for Node entry
scripts, use the stdin-piped runners:

```text
npm run claude:host-preflight:sandbox
npm run claude:host-canary:sandbox
npm run claude:live-host-canary:sandbox
npm run test:claude-host:sandbox
```

Set `CLAUDE_EXECUTABLE` to the native `claude.exe` when the npm shim is not on
PATH inside the sandbox Node environment.

`npm run amadeus:build` refreshes both the Codex package and the committed
`claude-plugin/` distribution. `npm run test:packaged` fails when either the
published Claude plugin or its root marketplace catalog drifts from the shared
canonical assets.

The builder checks canonical fidelity and source/runtime hashes before writing.
It refuses existing destinations, unexpected package files, symlinks, stale
runtime files and unmapped canonical requirements. It copies public scripts and
the packaged engine, never machine configuration or worker credentials. Failed
staging never replaces a previous candidate.

Claude's manifest, MCP path and SessionStart path are host translations. Default
component discovery avoids registering the same hook twice. Runtime identity
recognizes one Codex or Claude manifest and rejects ambiguous dual manifests.
State stays outside the candidate. Staging does not sign in, enable providers,
alter host settings, install dependencies or launch a model.

The host lifecycle adapter performs dependency preflight, then either:

- a deterministic filesystem-mirror install for verification, or
- documented `claude plugin` marketplace/install/enable/list commands with
  explicit local scope when the CLI is available (auto-staging a marketplace
  around the candidate and writing a reversible trust settings file when needed).

It preserves foreign Claude settings keys, never copies credentials, never
enables API-key billing, and never enables the signed-in worker path. Update
snapshots support rollback; disable and uninstall leave Amadeus durable state
intact.

## Optional worker path

The signed-in worker adapter (`claude-subscription-signin`) is separately
authorized in the shared engine and is **not** part of host-plugin acceptance.
It refuses API-key authentication, strips inherited environment variables except
basic process plumbing, requires containment receipts before implementation
dispatch, and reports progress/provider attribution without changing default
Cursor/Codex routing. Claude is selected only when pinned, worker-suggested, or
as a fallback after diagnosed Codex and Cursor failures when a Claude
environment is available.

```text
npm run claude:live-worker-canary -- <worker-config.json> <isolated-workspace> <evidence-directory>
```

## Evidence boundaries

Deterministic tests cover identical repeated staging, marketplace layout, a
complete shared runtime, packaged identity resolution without setup-path
authority, worker SessionStart recursion prevention and MCP initialization/tool
listing without state creation, destination collision refusal, canonical/runtime
drift, host install/update/rollback/disable/uninstall with settings preservation,
signed-in adapter fail-closed auth and dispatch gates, routing/fallback/
attribution parity, and version-bound canaries that report CLI presence or
absence honestly.

Live host canary evidence (`npm run claude:live-host-canary`) additionally
records marketplace add, install/enable/list (including
`amadeus@amadeus` enabled in `plugin list --json`), SessionStart
observation, MCP `plugin:amadeus:amadeus` connection, and same-engine checks
(runtime manifest hash + MCP tools + Amadeus skill bytes) under an isolated
`CLAUDE_CONFIG_DIR` when requested. Restricted app sandboxes may fail Git-bash
hook process launch even when the SessionStart script and MCP server succeed
via Node; the canary reports that honestly and does not claim matrix support
from a partial SessionStart shell failure.

Housekeeping: examined=canonical assets,host fixtures,shared runtime identity,host lifecycle scripts,marketplace staging,live host canary,signed-in adapter/driver,work routing,package scripts,compatibility contract,validation guidance,parity fixture; removed_or_quarantined=none; preserved=historical inert Claude fixture,existing Codex wrapper and default routes,canonical skills,local state and history,optional worker canaries
