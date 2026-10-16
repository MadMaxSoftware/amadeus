# Amadeus 0.3.9 - durable provider fallback and host reconciliation

Amadeus 0.3.9 is a patch release for the Codex and Claude host integrations.

## Fixed

- A provider whose isolation acceptance harness is unavailable is now excluded
  for the remainder of the current goal. A successful fallback iteration no
  longer makes that known-broken provider eligible again on the next step.
- Trusted ordinary-software verification can close the latest explicitly
  stopped iteration after the isolated worker has acknowledged the stop. Older
  iterations and still-running jobs remain ineligible for this path.
- The isolated packaged Claude verification fixture now includes both public
  marketplace catalogs, matching the files used by a real release build.
- Windows worker launches preserve Node's symlink-based module resolution while
  retaining the existing MXC isolation boundary, preventing sandbox EPERM
  failures when Node resolves packaged test entrypoints.

## Claude Desktop and Claude Code

The release includes `amadeus-claude-plugin-0.3.9.zip` for upload through
**Claude Desktop > Customize > Plugins**. The public GitHub marketplace remains
installable in Claude Code with:

```text
claude plugin marketplace add MadMaxSoftware/amadeus
claude plugin install amadeus@amadeus
```

## Verification

- Focused provider-routing and stopped-iteration regression tests.
- Full coordinator, packaging, Claude host, privacy, and public-safety suites.
- Packaged Codex and Claude distribution verification from an isolated Windows
  checkout.
- Security review of the final release diff.

Housekeeping: examined=provider routing,Cursor harness failure handling,goal reconciliation,Windows Node sandbox launch,Claude marketplace packaging,release metadata; removed_or_quarantined=none; preserved=privacy consent,durable user state,existing Codex and Claude install paths,Maestro alias behavior
