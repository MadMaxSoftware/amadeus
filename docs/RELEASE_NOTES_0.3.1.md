# Amadeus 0.3.1 — Public-trust guardrails

Amadeus now treats privacy as a product invariant rather than an informal
convention.

## What changed

- Added a public privacy policy and contributor privacy-impact review.
- Added a machine-readable, default-deny registry for the three permitted
  external flow classes.
- Bound update checks to the consented GitHub release endpoint.
- Bound local-model work to separately approved loopback providers.
- Added user-initiated, local-only, redacted support-bundle previews.
- Expanded safety scanning to tracked and distributable repository files.
- Added public-safety pull-request checks and privacy regression tests.

## What did not change

- No telemetry or repository feedback was enabled.
- No data is sent to Mad Max Systems by default.
- Local-model automatic routing remains closed on the stable channel pending
  the documented local-model release gate.
- Updates still need explicit activation approval and a desktop restart.
