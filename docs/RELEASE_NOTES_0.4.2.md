# Amadeus 0.4.2 - Economical routing, one set of rules for every AI

Amadeus 0.4.2 routes work to the cheapest suitable worker on the plan you are
already using, keeps going on a second plan when the first one runs out, and
applies one shared set of safety rules to every AI provider.

## Economical routing

- **Your chat's own provider first.** Workers now use the provider your chat
  runs on (Claude in Claude Code, Codex in Codex), so one plan does the work.
  The other installed provider is a reserve. This replaces 0.4.1's "use the
  provider the chat is not on". An owner `preferredProvider` still wins.
- **The cheapest tier that fits.** Plain software first, then the routine
  tier, the workhorse tier for hard design or diagnosis, and the frontier tier
  only for exceptional work.
- **Usage limits switch providers instead of pausing.** When a worker reaches
  its plan's usage limit and another installed provider is free, the same step
  continues there; the limited provider is skipped until its reset time. With
  no free provider the goal waits for the reset as before.

## Tiers, not model names

- One rule picks a model for every provider: your `tierModels` setting, else
  the provider's family names (Claude: `sonnet`, `opus`, which always mean the
  newest model of that family), else its live model list (Codex). Model
  updates need no Amadeus update.
- If a provider rejects a model name, the worker retries once on that
  provider's default model.
- Reports name the model for Claude as well as Codex.

## One set of rules for every AI

- Every provider is described once (sign-in folder, paid-key variables, tier
  names, usage-limit wording). Routing, privacy checks, usage limits and
  reports read that description.
- The sandbox rules, the safety checks run before every worker call and the
  worker environment rules are shared by Codex, Claude-style and Cursor
  workers. Where the old copies differed, the strictest version now applies to
  all of them.
- Each provider's sign-in folder is private to the other providers' workers.
- A snapshot test records every worker's sandbox permissions, so any change to
  what a worker may read or write is deliberate and reviewed.

## Grok (preview)

- Grok Build (`grok`) can run as a worker with a SuperGrok or X Premium+
  subscription sign-in; API keys are never used. It has not yet been run end
  to end, so it is off until you add
  `"enabledProviders": ["grok-subscription-signin"]` to the worker config.

## Fixes

- Worker instructions tell workers to hand host-only steps (such as running
  the full tests outside the sandbox) back to the chat instead of asking
  another worker.
