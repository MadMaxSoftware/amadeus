# Update Amadeus

Amadeus can tell you when a newer release exists. It never downloads,
installs or activates anything itself: you upgrade through your host's own
plugin command, then restart the host.

## Checking for updates

Update checks are off until you consent, and they contact only the GitHub
releases of `MadMaxSoftware/amadeus`.

1. Grant consent with `amadeus_update_consent` (`consent=true`). Declining or
   revoking consent stops all release queries. Consent is stored per machine in
   `updates/consent.json` under the Amadeus state root.
2. Ask for a check with `amadeus_check_updates`. Amadeus checks at most once per
   24 hours; a `force` check ignores that window. Nothing checks automatically
   when a chat opens or the host starts.
3. The result shows the installed and latest versions, the release notes link,
   and the upgrade command for the host you are running.

`amadeus_lifecycle_status` is read-only and never contacts GitHub.

Malformed, unavailable, older and equal releases are reported as such and change
nothing.

## Upgrading

Codex / ChatGPT desktop:

```bash
codex plugin marketplace upgrade amadeus
```

Claude Code:

```bash
claude plugin update amadeus@amadeus
```

Claude desktop app: chats there use a copy synced to your claude.ai account,
separate from Claude Code's. It updates after claude.ai has synced the new
version; restart the app to pick it up.

Restart the host afterwards so it reloads the plugin. Amadeus never replaces a
running plugin. Your goals and other state live outside the plugin folder and
are kept across upgrades; the state database is backed up daily.

Your host's plugin manager decides how to go back to an earlier version.
Amadeus itself keeps no staged copies or rollback snapshots.

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
