# Amadeus 0.3.4 - Generic runtime authority

Amadeus 0.3.4 corrects a legacy coupling defect from the product's earlier
single-machine coordinator history.

## Runtime and repair boundaries

- Public installs execute the runtime packaged with the installed Amadeus
  plugin. Persisted `setupRoot` and `coordinatorRoot` values no longer select
  executable code.
- Developer-source execution requires an explicit developer-mode choice and
  fail-closed Amadeus package, version, and repository identity checks.
- Ordinary goals require an explicit absolute project root. Amadeus no longer
  falls back to a global manifest tied to a legacy host checkout.
- Public self-repair is artifact-only. Source mutation is allowed only for a
  verified Amadeus development checkout under explicit developer mode; legacy
  or unrelated project trees are refused.
- Supervisor state, worker configuration, and project checkpoints no longer
  assume a parent host setup layout or private backup scripts.

## State preservation

Durable goals and history remain local. Legacy identifiers are retained only as
migration readers and never grant runtime or repair authority. New clean-machine
defaults use the per-user `Amadeus` state folder.

## Privacy and statistics

This release adds no telemetry. GitHub repository and release aggregates may be
used as rough public-interest indicators, but they are not represented as an
active-install count. Any future usage reporting requires a separate formal,
off-by-default, explicit, revocable privacy amendment.

## Verification

Regression coverage includes stale legacy configuration, packaged-runtime
selection, state preservation, developer identity/version mismatch, foreign
repair refusal, clean-machine portability, package integrity, privacy, public
safety, and the complete repository test suite.
