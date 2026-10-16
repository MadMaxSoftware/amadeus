# Installation and active-use statistics (Public-Trust assessment)

Amadeus follows the Public-Trust North Star in `PRIVACY.md`: no hidden
telemetry, no unique installation identifiers, no heartbeats, and no network
collection for analytics in the current product.

This document records what can be known **without** implementing telemetry, and
how any future accurate counting would have to be designed.

## What GitHub aggregate metrics can show

For the public repository `MadMaxSoftware/amadeus`, GitHub may expose
**aggregate, repository-level** signals such as:

- stars, forks, and watchers;
- traffic views and unique clones (short retention, approximate);
- release download counts for published assets;
- marketplace / dependency insights when GitHub provides them for the package.

These figures are useful for rough interest and release uptake. They are **not**
a count of active Amadeus installations, healthy coordinators, or distinct
end-user machines.

## What GitHub aggregate metrics cannot show

GitHub cannot truthfully answer:

- how many desktops currently run the Amadeus plugin;
- how many coordinators are healthy or actively orchestrating work;
- which machines upgraded, rolled back, or retained durable state;
- user goals, prompts, paths, hardware, model inventory, or provider choices.

Clone and download totals also over-count CI, mirrors, and repeated fetches, and
under-count sideloaded or cached installs. They must not be marketed as
“active users.”

## Current product behavior (this milestone)

- No inventory scan, installation ID, heartbeat, analytics endpoint, or LAN scan.
- No credentials or execution traces leave the machine for product analytics.
- Optional consented flows remain limited to the declarations in
  `plugins/amadeus/privacy-flows.json` (release checks, loopback local models,
  selected subscription providers).
- Support bundles are local, redacted, previewed, and never uploaded by Amadeus.

## Future telemetry amendment (design only — not implemented)

Any accurate installation or active-use counting would require a **separate,
formal, explicit, revocable, off-by-default** privacy amendment before code
lands. Minimum design constraints:

1. **Off by default** — declining never disables unrelated coordination.
2. **Itemized consent** — purpose, recipient, categories, retention, and
   revocation spelled out in plain language.
3. **Local payload preview** — user can inspect exactly what would be sent.
4. **Minimal aggregates** — prefer coarse counters (for example, “install ping
   once per major version”) over identity graphs; no prompts, source, paths, or
   hardware inventory.
5. **Revocation** — stopping consent stops transmission; prior aggregates are
   not retroactively enriched.
6. **No silent expansion** — new categories need a new amendment and versioned
   disclosure; earlier consent never applies retroactively.
7. **Public documentation** — update `PRIVACY.md` and the privacy-flow registry
   in the same release.

Until that amendment exists, Amadeus must not implement network collection for
usage statistics. Prefer honest documentation of GitHub limits over inaccurate
“active install” claims.


