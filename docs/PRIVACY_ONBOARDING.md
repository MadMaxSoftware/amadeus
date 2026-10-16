# Setup and privacy choices

The registered setup skill explains normal operation once and offers independent
discovery and update choices. Skipping or declining either choice never
disables ordinary coordination. Status is read-only even without the backend.

## Normal dependencies

amadeus_dependency_health checks known Node, Git, Codex and optional Cursor paths,
configured providers and existing model caches. Known configured route version
and sign-in checks remain ordinary task preflight. No inventory consent or
recurring warning is needed. Mention missing dependencies only when relevant.

## Optional discovery

Disclosure version 3 covers hardware, development-tools and local-providers as
separately selectable scopes. Older grants must be renewed and are never expanded.
amadeus_provider_discovery_consent records the displayed version and scopes.
It never starts collection. Use these separate actions:

- amadeus_discovery_preview: sources, selected categories/locations and limits.
- amadeus_discovery_run: a separate user scan request (requested: true) AND consent.
- amadeus_discovery_view: read local saved results.
- amadeus_discovery_delete: delete results and discovery-derived provider records.

Windows collectors use selected CIM CPU/GPU/RAM/OS fields, relevant uninstall
entries, fixed known paths and explicitly selected local roots. Model collectors
query fixed loopback model-list endpoints. No personal-document crawling, network
shares, LAN, serial numbers, inference, model loading or discovered-app launches.
Presence does not establish licensing, sign-in or compatibility. CIM GPU memory
can be incomplete. Other operating systems report Windows collectors unsupported.

Consent lives in providers/discovery-consent.json under private state. Missing,
malformed, outdated, declined, revoked or incorrectly scoped consent blocks
collection. Revocation is checked between queries and during asynchronous work;
results from an interrupted scan are discarded. Prior results remain until
deleted. The legacy manual provider scan tool uses the same local-providers scope.
Detection does not grant routing approval; stable local-model routing is still
pilot-gated.

Updates use amadeus_update_consent. Status never contacts release servers.
This release has no telemetry, fault-intake service, or repository feedback path.

## CLI and migration

npm run amadeus:onboard displays the discovery choice. Enter keeps it disabled.
--non-interactive never grants permission. --privacy-only works without a runtime.
--discovery-consent allow|deny|skip records a scripted choice, never a scan.
--state-root, --config and --setup-root support explicit existing installations.
amadeus_setup seeds missing packaged defaults, preserving goals/configuration.
amadeus_configure_runtime is an optional existing-checkout override. Existing
AMADEUS_HOME remains supported. Ordinary onboarding does not copy consent when
pointing at a new root; intentional durable moves use the dry-run-first workflow
in [State migration](STATE_MIGRATION.md).
