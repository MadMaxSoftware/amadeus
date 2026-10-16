# Amadeus 0.3.7 - Claude Code host integration

Amadeus 0.3.7 publishes the verified Claude Code host-integration work so users
can install and use Amadeus from both Codex / ChatGPT desktop and Claude Code.
Existing Codex marketplace behavior is preserved. Claude-as-an-Amadeus-worker
remains optional and is not required for host-plugin use.

## Claude Code as a host

- A Claude Code candidate is staged from the same canonical assets and packaged
  runtime used by the Codex wrapper, with host path variables translated to
  `${CLAUDE_PLUGIN_ROOT}`.
- The public repository now contains `.claude-plugin/marketplace.json` and a
  generated `claude-plugin/` distribution, so users can add
  `MadMaxSoftware/amadeus` directly as a Claude marketplace without cloning or
  building the repository.
- SessionStart loads the same packaged hook as Codex. User-facing skills and
  commands include `/amadeus:amadeus`, `/amadeus:maestro`, and `/amadeus:setup`.
- Deterministic package, lifecycle, and signed-in-worker-separation tests cover
  the host path. A reversible live canary exercises marketplace add/install/
  enable/list, SessionStart observation, MCP connection, and same-engine checks
  against a signed-in Claude Code CLI when available.
- Claude-as-worker (`claude-subscription-signin`) stays separately authorized,
  refuses API-key billing paths, and does not change default Codex or Cursor
  routing.

## Codex path unchanged

- `codex plugin marketplace add MadMaxSoftware/amadeus` and
  `codex plugin marketplace upgrade amadeus` remain the supported Codex friend
  paths.
- Packaged-runtime authority, worker isolation, Maestro-as-alias behavior, and
  optional Cursor routing from 0.3.6 remain in force.

## Privacy and compatibility

- No telemetry or new data collection is introduced.
- Optional provider discovery, Cursor use, Claude worker use, and update checks
  remain separately controlled.
- Existing public-safety, privacy, and clean-tree release gates remain required.

## Install

### Codex / ChatGPT desktop

```bash
codex plugin marketplace add MadMaxSoftware/amadeus
# or, when already installed:
codex plugin marketplace upgrade amadeus
```

Restart the desktop host after upgrading.

### Claude Code

```text
claude plugin marketplace add MadMaxSoftware/amadeus
claude plugin install amadeus@amadeus
```

Restart Claude Code or run `/reload-plugins`, then use `/amadeus:setup`. See
[docs/CLAUDE_CODE.md](CLAUDE_CODE.md) for SessionStart expectations, updates,
and verification commands.
