# Contributing to Amadeus

Read `PRIVACY.md` before proposing or implementing a change. Privacy-safe
improvements follow the normal roadmap. Privacy-sensitive ideas must use the
review lane below; do not weaken the existing behavior merely to make a feature
easier to ship.

## Privacy-impact declaration

For every change that reads, generates, stores, or transmits user or machine
information, document:

- information read or generated;
- destination and recipient;
- purpose;
- trigger and default state;
- consent and revocation mechanism;
- retention; and
- behavior when consent is declined.

New network-capable behavior must use a flow declared in
`plugins/amadeus/privacy-flows.json`. Adding or broadening a declaration is a
privacy-policy change and requires the formal amendment process in `PRIVACY.md`.

## Required checks

Run:

```powershell
npm run public-safety
npm test
npm run amadeus:self-test
git diff --check
```

The public-safety workflow must pass before merge. Emergency changes are not an
exception to the checks.

