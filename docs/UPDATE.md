# Update Amadeus

Amadeus 0.3.x supports **consent-based** update checking against
`MadMaxSoftware/amadeus` only. After consent, Amadeus may check on **startup**
and again when the **24-hour** cache window has elapsed. Explicit
`amadeus_check_updates` uses the same policy. Read-only
`amadeus_lifecycle_status` never contacts GitHub. Newer releases show metadata;
**activation requires explicit approval**. Amadeus never hot-replaces a running
plugin: approved updates leave a pending-restart state. Rollback snapshots are
preserved when activation is approved.

## Update (recommended)

```bash
codex plugin marketplace upgrade amadeus
```

Restart Codex / ChatGPT desktop so it reloads the plugin cache. Confirm the
installed cache version matches `plugins/amadeus/.codex-plugin/plugin.json`.

## Consent and staged activation (development / owner tools)

1. Grant update-check consent (`amadeus_update_consent` with `consent=true`, or
   write the per-machine consent file under the Amadeus state root
   `updates/consent.json`). Declining consent skips all remote checks.
2. After consent, startup and `amadeus_check_updates` may query only
   `MadMaxSoftware/amadeus` (subject to the 24-hour window). Lifecycle status
   remains read-only and does not contact GitHub.
3. Review owner-visible release metadata (version, notes, URL).
4. Stage and approve activation explicitly when a newer release should be
   applied. This writes pending-restart guidance and preserves rollback state.
5. Invoke the marketplace upgrade command above, then restart the desktop host.
6. Use rollback only to restore a preserved prior snapshot if needed.

Malformed, unavailable, older, equal, partial, and declined-consent cases do not
activate an update.

## Optional local checkout update

1. Pull or replace this repository checkout with the newer release tag.
2. Re-run:

```powershell
node scripts/install-dependencies.mjs
npm run amadeus:privacy
npm run amadeus:self-test
powershell -File scripts/Activate-AmadeusPersonalPlugin.ps1
```

3. Restart the Codex / ChatGPT desktop host so it reloads the plugin cache.
