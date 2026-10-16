# Amadeus — Local AI Orchestrator

**Amadeus helps Codex keep substantial work moving until the requested outcome
is genuinely finished.** It turns a larger request into durable, verifiable work,
uses ordinary computer software wherever a model is unnecessary, routes the
remaining work to suitable AI available on the computer, and preserves progress
through long runs, failures, restarts, and upgrades.

Amadeus is a public Codex / ChatGPT and Claude plugin by **Mad Max Systems**.
**Maestro** is simply an alias for Amadeus: the same instructions,
behavior, and orchestration engine under another name.

## Why this can reduce AI usage and cost

Many substantial tasks mix work that needs AI reasoning with work that does
not: searching files, running tests, building packages, checking results, and
performing exact transformations. Amadeus sends those deterministic steps to
ordinary software instead of spending another model call on them. It also
preserves verified progress so a failed or interrupted run does not need to
repeat unchanged AI work.

That design reduces the average amount of AI usage needed across a mixed
workflow. In practice, it can preserve subscription allowance and reduce costs
when a provider charges by usage. The reduction varies with the task and the
available providers; Amadeus does not claim a universal savings percentage
without comparable measured evidence. Its task reports distinguish ordinary
software from AI-provider work so users can see how their own work was routed.

## What Amadeus does

- Keeps long-running goals and their evidence in durable local state instead of
  relying on one chat response to finish everything.
- Uses ordinary software first for searches, builds, tests, file operations,
  validation, and other deterministic work that does not need another AI call.
- Routes reasoning and implementation to the lowest capable available signed-in
  provider. Cursor can be used when installed, but it is optional.
- Works in isolated project copies, verifies generated changes independently,
  and applies only changes that pass integrity, conflict, and project checks.
- Preserves incomplete and failed work rather than quietly declaring success or
  discarding useful evidence.
- Reports what was completed, what remains, who did the work, and whether the
  owner genuinely needs to act—in ordinary language.
- Starts automatically in supported local chats after the host permission is
  approved. Simple questions remain lightweight, and Amadeus can be bypassed
  for any individual task.

In practical terms, you can ask for a substantial development or computer-based
outcome and let Amadeus coordinate the repetitive software work, AI workers,
verification, recovery, and continuation needed to finish it.

## Providers and local AI

Amadeus does not require Cursor or a particular external model. Its intended
routing order is:

1. ordinary software for deterministic work;
2. an approved and qualified local model, when available;
3. optional Cursor when installed and suitable;
4. a capable signed-in Codex model.

Consent-based discovery can identify supported local AI runtimes on the current
computer without scanning the LAN. Detection never grants permission to use a
provider. Local-model routing remains experimental and disabled on the stable
channel until the public qualification gate passes.

## Privacy and control

Amadeus is local-first and public-safe by default:

- No telemetry, hidden usage reporting, fault uploads, or automatic repository
  feedback is included.
- Optional provider discovery and update checks have separate, explicit,
  revocable consent.
- Declining optional discovery does not disable normal coordination.
- Goals, prompts, paths, provider settings, benchmarks, and execution evidence
  stay on the user's computer.
- Public installations cannot silently edit Amadeus source. Repairs remain
  local reviewable artifacts unless an explicitly verified developer workflow
  is being used.
- Updates are never hot-installed over a running plugin and require approval
  before activation.

See [PRIVACY.md](PRIVACY.md) for the public promise and
[docs/PROJECT_CHARTER.md](docs/PROJECT_CHARTER.md) for the product boundaries.

## Install

### Codex / ChatGPT desktop

```bash
codex plugin marketplace add MadMaxSoftware/amadeus
```

Then open Codex / ChatGPT Plugins, select the **Amadeus** marketplace, enable
**Amadeus**, and run Setup. Approve **Start Amadeus automatically** if you want
coordination available by default in new supported local chats. Setup does not
scan the computer or enable paid APIs.

### Claude Code

```bash
claude plugin marketplace add MadMaxSoftware/amadeus
claude plugin install amadeus@amadeus
```

Restart Claude Code or run `/reload-plugins`, then use `/amadeus:setup`.
Claude-as-an-Amadeus-worker is optional and is not required to use Amadeus in
Claude Code.

### Claude Desktop Chat and Cowork

Claude Desktop and Claude Code use the published Amadeus marketplace package.
Existing marketplace installations receive published updates through their
normal marketplace update flow; no separate desktop ZIP upload is required.
The Amadeus skills are available in Chat, Cowork, and Claude Code. Full local
coordination runs in Cowork and Claude Code, not ordinary Chat.

Share this link: <https://github.com/MadMaxSoftware/amadeus>

## Update

```bash
codex plugin marketplace upgrade amadeus
```

Restart Codex / ChatGPT desktop after upgrading. See
[docs/UPDATE.md](docs/UPDATE.md) for the consent-based update, approval,
rollback, and restart model.

## Current release

Version **0.3.11** adds one generic, local Windows UI Automation engine for
Codex and Claude. Host AIs can inspect and operate exposed application controls,
including text entry, without purchasing a separate model turn for each
deterministic interaction. ZEISS INSPECT is the first compatibility fixture,
not a hard-coded application restriction.

Full notes: [docs/RELEASE_NOTES_0.3.11.md](docs/RELEASE_NOTES_0.3.11.md).

## License

Amadeus is licensed under the [Apache License 2.0](LICENSE). Contributions,
including proposed fixes in repair reports, are accepted under the same license.

## Repository layout

- `.agents/plugins/marketplace.json` and `marketplace.json` — Codex marketplace catalog
- `plugins/amadeus/` — installable Amadeus plugin
- `.claude-plugin/marketplace.json` and `claude-plugin/` — Claude Code marketplace and generated plugin
- `src/` — coordinator source packaged into the plugin runtime
- `agent-package/` — canonical assets used to generate and verify the Codex wrapper
- `docs/` — installation, privacy, architecture, validation, and roadmap
- `scripts/` — build, verification, migration, and optional local helpers

Contributor and operating references:

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [docs/INSTALL.md](docs/INSTALL.md)
- [docs/ONBOARDING.md](docs/ONBOARDING.md)
- [docs/VALIDATION.md](docs/VALIDATION.md)
- [docs/ROADMAP.md](docs/ROADMAP.md)
- [docs/DEVELOPMENT_STATUS.md](docs/DEVELOPMENT_STATUS.md)
- [docs/HOST_COMPATIBILITY.md](docs/HOST_COMPATIBILITY.md)
- [docs/LOCAL_MODEL_PILOT.md](docs/LOCAL_MODEL_PILOT.md)
