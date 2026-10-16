# Local-model routing release gate (0.5.x)

Amadeus 0.3.x includes consent-based local-provider discovery and an
experimental isolated OpenAI-compatible worker. Automatic local-model routing
remains disabled on the stable channel until this release gate passes.

## Required privacy and isolation properties

- Communicate only with an explicitly approved loopback endpoint
  (`127.0.0.1`, `localhost`, or `::1`).
- Never scan a LAN, read credentials, or silently enable a detected provider.
- Restrict model tools and files to the isolated project workspace and explicit
  allowlist.
- Keep provider configuration, model inventory, benchmarks, prompts, paths,
  hardware details, and execution evidence on the user's machine and outside
  release artifacts.
- Keep discovery consent, provider enablement, and update activation separate
  and revocable.
- Preserve ordinary software and signed-in model fallbacks when local inference
  is unavailable or invalid.

## Qualification checks

Before a model can receive work, local evaluation must verify the capabilities
needed for that task class, including as applicable:

- endpoint health and model enumeration;
- instruction following and structured JSON;
- tool-call correctness;
- repository analysis and bounded patch generation;
- adequate context capacity;
- repeatability, timeout handling, and failure recovery.

Detection alone grants no work authority. An unqualified, slow, malformed, or
disappearing model must be excluded without repeating the unchanged attempt.

## Stable-release acceptance

Stable automatic local-model routing may be enabled in 0.5.x only when all of
the following are demonstrated on representative, consented local installations:

| Gate | Requirement |
| --- | --- |
| Privacy | No LAN access, credential reads, telemetry, or release-artifact leakage |
| Consent | Discovery and each provider are separately approved and revocable |
| Isolation | Workspace and tool boundaries prevent unapproved access |
| Qualification | Models receive only capabilities they demonstrably pass |
| Reliability | Invalid output, timeout, context overflow, and disappearance fall back safely |
| Verification | Independent tests and patch-integrity checks run before changes apply |
| Compatibility | A clean computer without Cursor or local models still works |
| Evidence | Reviewable pass/fail evidence remains local and private by default |

Until those gates pass, `stableChannelLocalRoutingStatus().localAutomaticRouting`
and `isLocalModelPilotGateOpen({ releaseChannel: "stable" })` remain `false`.

## Experimental use

Experimental routing may be enabled only by an informed user on that machine.
Experimental results do not change stable defaults, publish machine inventory,
or imply that the stable release gate has passed. Any eventual stable change
must arrive through the normal reviewed, tested, versioned release process.
