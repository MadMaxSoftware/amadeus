# Amadeus privacy and public trust

Amadeus is a public product. User privacy and autonomy take priority over
analytics, growth, convenience, and feature requests.

## Default behavior

- Amadeus has no hidden telemetry and sends no data to Mad Max Systems by
  default.
- Credentials, prompts, source code, paths, hardware details, model inventory,
  and execution traces are not centrally collected.
- Machine configuration, provider inventory, qualification evidence, update
  state, and durable work state remain on the user's computer and outside the
  public plugin package.
- Optional consent may be declined without disabling unrelated core behavior.
- LAN discovery and arbitrary remote provider probing are forbidden.
- Startup coordination performs no inventory collection, feedback transmission,
  or update check merely because a chat opened.

## External data flows

Every permitted external flow is declared in
`plugins/amadeus/privacy-flows.json`. A declaration names the recipient,
purpose, data categories, trigger, consent, retention, and revocation behavior.
Runtime guards fail closed when a flow, endpoint, or consent does not match the
declaration.

The declarations are limited to:

1. consented GitHub release checks for `MadMaxSoftware/amadeus`;
2. separately approved loopback-only local-model communication; and
3. explicitly selected Codex, Cursor, Claude or Grok subscription-provider execution
   (Grok only after the owner adds it to `enabledProviders`).

The coordinator checks every subscription-provider dispatch against this
declaration and refuses a provider that is not listed.

Amadeus does not treat permission for one purpose or recipient as permission
for another. Revoking update consent stops release queries. Revoking provider
approval stops that provider from receiving work. Existing local state can be
removed from the per-machine Amadeus state directory described in
`docs/ONBOARDING.md`.

Optional discovery additionally requires current scope-specific consent and a
separate scan request. It does not scan the LAN, crawl personal documents, load
models, or launch discovered applications. Results stay in per-machine state
and can be viewed and deleted locally.

## Repair and product learning

Public installations may preserve failed work and local diagnostic evidence,
but they do not silently modify the installed plugin or send repairs upstream.
There is no telemetry, fault-intake service, or automatic repository feedback
path in this release. Improvements are made in the source repository, reviewed,
tested, versioned, and delivered through an approved update and restart.

A future feedback capability would require its own formal privacy amendment,
itemized consent, exact local payload preview, revocation, retention limits, and
server-side authorization for developer-only actions. A local `developer=true`
setting or installation path can never grant repository authority.

## Support information

Support bundles are user-initiated, generated locally, redacted, and previewed
before they are written. Amadeus never uploads a support bundle. The user must
choose whether and how to share a reviewed bundle.

## Changes to this promise

A feature request, including an owner request, cannot silently weaken this
policy. A conflicting request must be refused and redesigned. A policy change
requires a separate formal amendment with a privacy-impact and threat review,
public disclosure, consent and migration analysis, regression tests, and an
appropriate versioned release. Earlier consent is never applied retroactively.

Future telemetry may be considered only as a distinct, off-by-default feature
with itemized consent, local payload preview, revocation, and no loss of
unrelated functionality when declined. Amadeus 0.4.2 contains no telemetry.

GitHub stars, clones, and release download totals are aggregate repository
signals only; they are not active-install counts. See `docs/USAGE_STATISTICS.md`
for limits and for the design constraints of any future counting amendment.
No usage telemetry is implemented in this release.
