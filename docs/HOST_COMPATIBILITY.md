# Cross-host compatibility contract (0.4 foundation)

Status: package foundation and acceptance contract, 2026-10-15. The Codex
wrapper is generated and tested. `scripts/build-claude-package.mjs` stages a
complete Claude candidate from the same canonical assets and packaged engine.
`scripts/claude-host-lifecycle.mjs` implements install/update/rollback/disable/
uninstall with dependency preflight; the shared engine adds a separately
authorized `claude-subscription-signin` worker adapter. Neither path claims
live compatibility without a signed-in Claude environment.
`host-fixtures/claude-code` remains the historical inert mapping fixture. No
other candidate has passed an Amadeus live pilot. See `docs/CLAUDE_CODE.md` for
current evidence and remaining gates. “Host support” means a particular local
host surface and tested version, not every web, mobile, cloud, or IDE surface
sold under the same brand.

## Package and adapter boundaries

- **Canonical package:** `agent-package/package.json` declares the versioned
  source assets for Amadeus/Maestro skills, MCP entrypoint, startup behavior,
  and privacy metadata. Existing plugin scripts remain the shared coordinator
  implementation. `npm run amadeus:build` generates the
  Codex wrapper and packaged runtime; `npm run test:packaged` checks fidelity.
  The manifest records SHA-256 hashes. This is a package boundary, not a claim
  that Agent Plugins 1.0 has been tested on another host.
- **Generated host wrapper:** A reproducible, version-matched output translates
  the canonical package into each host's manifest, paths, startup hook,
  permissions, and user-facing setup copy. Host-only files contain no forked
  coordinator logic or independent policy. Generation must fail on an
  unrepresentable requirement; a silent partial wrapper cannot claim support.
- **Host installation adapter:** Installs, registers, updates, disables, and
  removes that wrapper using the host's documented local mechanism. It obtains
  hook/MCP trust and preserves host-specific rollback. It does not select an AI
  worker or inherit permission to discover providers.
- **Signed-in worker adapter:** Runs a bounded task through an already available,
  owner-authorized signed-in route, maps model/session capabilities, and reports
  usage, failure, and attribution to the coordinator. It is independent of
  which host loaded Amadeus. Host installation never implies worker sign-in,
  API billing, provider enablement, or access to another host's credentials.
- **Runtime/state:** The packaged, version-checked coordinator remains executable
  authority. Durable goals and local configuration remain outside packages.
  No wrapper may move state into a plugin cache or load code from a persisted
  setup path. The public-trust rules in `PRIVACY.md` apply identically.

## Candidate matrix

Official documentation establishes potential integration mechanisms, not
Amadeus compatibility. “Unverified” means no installation, sign-in, or
execution was performed for this milestone.

| Candidate local surface | Documented candidate mechanism | Amadeus status / gap |
| --- | --- | --- |
| Codex / ChatGPT desktop local runtime | [OpenAI plugin architecture](https://developers.openai.com/plugins/concepts/plugins) documents skills, MCP, and local lifecycle hooks; web installation does not deploy hook scripts | Existing 0.3.8 Codex implementation; baseline marketplace add/upgrade behavior preserved. ChatGPT web/mobile excluded from full local-runtime support. |
| Claude Code CLI | [Claude Code plugins](https://code.claude.com/docs/en/plugins) and [marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) describe public GitHub marketplace installation and local lifecycle extension points | **Published host package + direct GitHub marketplace lifecycle; worker optional.** The same `MadMaxSoftware/amadeus` repository can be added directly, and its generated Claude distribution is checked against the shared engine. Install/update/rollback/disable/uninstall are tested. Live signed-in canary under reversible isolated config verified marketplace add/install/list-enabled, session skill/MCP load, SessionStart dispatch, and same-engine hashes. App-sandbox Git-bash may still fail hook process launch even when the hook script and MCP succeed; report that gap honestly without disabling the published install path. |
| Claude Desktop Chat / Cowork | [Anthropic's plugin guidance](https://support.claude.com/en/articles/13837440-use-plugins-in-claude) documents custom plugin upload and explains that local MCP servers and hooks run in Cowork and Claude Code, not ordinary Chat | **Release ZIP supplied for custom upload.** Skills are available in Chat, Cowork, and Claude Code. Full local Amadeus coordination is limited to Cowork and Claude Code. A Claude Code GitHub-marketplace install is local and does not populate the Desktop account plugin list; account-installed plugins may sync one-way into Claude Code. |
| GitHub Copilot CLI | [CLI customization](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/overview) and [hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference) document skills, MCP, plugins, and local hooks | Candidate; unverified. Cloud agent and other Copilot surfaces require separate qualification. |
| Cursor local IDE | [Cursor plugin reference](https://cursor.com/docs/reference/plugins) documents Agent Plugins and Cursor-specific hooks; standard MCP path variables are not expanded the same way | Candidate; unverified. A generated wrapper must resolve path variables and lifecycle semantics. Web/cloud/mobile surfaces are outside this local-host claim. |
| Gemini CLI | [Extension reference](https://geminicli.com/docs/extensions/reference/) documents MCP and extension hooks; [hooks reference](https://geminicli.com/docs/hooks/reference/) documents local lifecycle events | Candidate; unverified. Its extension format needs a generated wrapper and consent/trust parity testing. |
| Grok Build CLI | [xAI Build extension docs](https://docs.x.ai/build/features/skills-plugins-marketplaces) and [official hook guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md) document plugins, MCP, and local hooks | Candidate; unverified. Test installed plugin discovery, trust, hook dispatch, and signed-in route separately; documented compatibility is not Amadeus proof. |

## Full-support parity gate

The Claude Code fixture checks version, canonical asset presence, manifest
parsing, MCP path mapping, and SessionStart mapping without invoking a host.
The pilot checks in `host-fixtures/claude-code/parity.json` remain open.

For a pinned host and operating-system version, a clean local installation must
pass all checks below with synthetic data and reviewable, privacy-safe evidence:

1. **Package fidelity:** generated wrapper has deterministic contents, matching
   version and tool schemas; package check detects drift and missing assets.
2. **Install lifecycle:** install, consented enablement, session restart,
   update staging, rollback, disable, and uninstall work without editing
   installed plugin caches or losing local goals/history.
3. **Entrypoint parity:** both Amadeus and Maestro load; MCP tools and the
   default trusted local startup hook run once, stay lightweight, respect bypass,
   and avoid recursive triggering. If the host lacks a local hook/runtime,
   full support fails even if skills can be read.
4. **Authority and isolation:** only packaged, version-checked code runs;
   worker copies, allowed paths, patch integrity, and independent verification
   fail closed on mismatch. Persisted paths never become executable authority.
5. **Consent and privacy:** decline and revocation paths work; no inventory,
   provider enablement, network flow, telemetry, or credential access occurs
   without its separately documented authority. Public-safety scans pass.
6. **Worker separation:** no worker is inferred from host installation.
   An authorized signed-in worker can receive a bounded task and return
   attribution, errors, and completion evidence. Unavailable workers degrade
   safely to ordinary software and another authorized route.
7. **Recovery and reporting:** interruption, timeout, malformed response,
   conflict, and restart preserve durable state and do not claim completion;
   owner-facing status names actual work and remaining action.
8. **Release gate:** host-specific pilot fixtures and tests plus existing
   packaged, branding, privacy, public-safety, and diff checks pass. Record
   host version, platform, pass/fail evidence, known exclusions, and rollback.

A host can be labelled “experimental pilot” only with explicit opt-in and
bounded evidence. “Supported” requires all eight gates on the claimed local
surface. A web or mobile surface without local hooks and runtime cannot satisfy
the gate and must be labelled limited/read-only, if offered at all.

## Historical foundation milestone decision record

The package foundation generates and verifies the existing Codex wrapper. It
does not activate providers or imply worker sign-in from host installation. The
0.3.11 release keeps the Claude Code and Claude Desktop marketplace paths,
adds the shared generic Windows UI Automation runtime, and keeps Claude-as-worker
optional. The separately
paused long-haul goal remains paused.
Other candidate hosts still need consented local pilots.

Housekeeping: examined=roadmap,charter,validation,local-model gate,README,package scripts,marketplace and plugin boundaries; removed_or_quarantined=none; preserved=existing Codex runtime and manifests,privacy commitments,historical release notes,local state and history,paused long-haul goal
