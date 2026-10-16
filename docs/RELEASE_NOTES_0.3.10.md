# Amadeus 0.3.10 - working Cursor and Claude workers on Windows

Amadeus 0.3.10 is a Windows compatibility patch for the signed-in Cursor and
Claude subscription workers.

## Fixed

- Cursor now uses the existing browser-login session through an exact read-only
  `auth.json` grant. Credentials are not copied and API-key billing remains
  prohibited.
- Cursor can read the repository metadata required to establish project context
  while model tools remain restricted and Git metadata stays read-only.
- Claude keeps its existing subscription sign-in directory in place and uses a
  versioned, hash-verified staging location for its native Windows executable.
- Both providers place per-job configuration and temporary files under an
  ignored `.amadeus-runtime` directory inside the canonical isolated workspace.
  Only the selected job child is writable; neighbouring runtime paths remain
  denied.
- Workspace paths exposed through migrated Windows junctions are canonicalized
  before MXC policy evaluation, removing the EPERM failures that prevented real
  Node suites and provider launches.
- The full Windows release suite now runs test files serially so concurrent
  crash-recovery fixtures cannot create timing-only false failures.
- Cursor and Claude worker progress now reports concrete preparation, tool,
  edit, and completion activity instead of looking frozen behind repeated lease
  messages.

## Verification

- Real signed-in Cursor response through the Amadeus adapter, with no credential
  copy and no API billing.
- Real signed-in Claude response through the Amadeus adapter, including denial
  of a credential-directory sentinel read.
- 138 source tests, 15 packaged-release tests, and 14 Claude-host tests.
- Public-safety scan of 341 repository files and 81 plugin files.
- Complete 43-item security diff review with no reportable findings.

The release includes `amadeus-claude-plugin-0.3.10.zip` for Claude Desktop
custom upload and remains installable from both the Codex and Claude Code public
marketplaces.

Housekeeping: examined=Cursor authentication boundary,Claude sign-in boundary,MXC filesystem policy,workspace canonicalization,worker runtime layout,provider executable staging,host canaries,packaged manifests,release metadata; removed_or_quarantined=temporary diagnostics; preserved=privacy consent,durable user state,existing subscriptions,Maestro alias behavior
