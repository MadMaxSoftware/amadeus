# Install Amadeus

Amadeus - Local AI Orchestrator by Mad Max Systems.

## Install (recommended)

Share this repository link: `https://github.com/MadMaxSoftware/amadeus`

Then run:

```bash
codex plugin marketplace add MadMaxSoftware/amadeus
```

Open Codex / ChatGPT Plugins, choose the **Amadeus** marketplace, and enable
**Amadeus**. Restart the desktop host if the plugin list does not refresh.
Do not claim the desktop UI refreshed until that restart check succeeds.

Run the registered Setup workflow. The coordinator is bundled; no developer
checkout is needed. Setup explains routine dependencies and separate optional
privacy choices. Approve **Start Amadeus automatically** through the host, then
verify a fresh supported local chat. See [Onboarding](ONBOARDING.md).

Packages that start with a new chat currently support manual desktop/GitHub
marketplace installation, but not the public universal plugin directory.
Web/mobile activation is outside this release. See the official
[packaging documentation](https://developers.openai.com/plugins/build/plugins).

## Claude Code install

Add the same public GitHub repository as a Claude Code marketplace, then install
Amadeus from it:

```text
claude plugin marketplace add MadMaxSoftware/amadeus
claude plugin install amadeus@amadeus
claude plugin list --json
```

Restart Claude Code or run `/reload-plugins`, then use `/amadeus:setup`. See
[CLAUDE_CODE.md](CLAUDE_CODE.md) for scopes, update commands, and verification.
Claude-as-an-Amadeus-worker remains optional and is not required for host use.

## Claude Desktop Chat and Cowork install

Claude Desktop and Claude Code use the published Amadeus marketplace package.
Install or enable Amadeus from the marketplace once; subsequent published
versions follow the host's normal marketplace update flow. No separate desktop
ZIP upload is required.

The skills and commands are available in Chat, Cowork, and Claude Code. Full
local coordination runs in Cowork and Claude Code; ordinary Chat can use the
skills but does not run the local coordinator.

## Requirements

- Codex CLI or ChatGPT desktop with plugins support, Claude Code CLI, and/or a
  Claude plan that supports marketplace plugins
- Node.js 24 or newer on PATH as `node` when running the local coordinator runtime
- A ChatGPT-signed-in Codex / GPT subscription route when model work is needed
- Cursor is optional and never required
- Claude Code signed-in subscription is optional and only needed for the
  separately authorized Claude worker route

## Optional local checkout

1. Clone `https://github.com/MadMaxSoftware/amadeus` onto the clean computer.
2. From the repository root:

```powershell
node scripts/install-dependencies.mjs
npm run amadeus:onboard
npm run amadeus:privacy
npm run amadeus:self-test
```

3. Register a personal marketplace mirror (relative in-root path) if needed:

```powershell
powershell -File scripts/Activate-AmadeusPersonalPlugin.ps1
```

Users do **not** need any private host setup tree. This repository is the
public marketplace root (`.agents/plugins/marketplace.json` + `plugins/amadeus`).
The dependency helper checks Node and bundled files, then seeds missing
configuration under private Amadeus state. It does not inspect installed tools,
start provider discovery, or write configuration into the checkout. An optional
privacy choice can remain pending after successful setup. On a checkout without
built runtime files, run `npm run amadeus:build` first.
