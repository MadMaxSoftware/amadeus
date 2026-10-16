---
name: setup
description: Set up Amadeus after installation, explain normal dependency checks, choose optional privacy settings, and verify Amadeus is available automatically in a supported local chat.
---

# Set up Amadeus

1. Call `amadeus_onboarding_status`. Explain the returned ready, setup incomplete,
   or unavailable state accurately. If setup incomplete, call `amadeus_setup` to
   seed missing configuration from the bundled package defaults. Preserve all existing
   goals, configuration and choices. Never require a developer source checkout.
2. Explain once: Amadeus quietly checks known Node, Git, Codex, optional Cursor,
   configured providers and cached model availability to operate. Call
   `amadeus_dependency_health` when checking setup. Only mention missing
   dependencies that affect the requested work. Do not install automatically
   just to complete this onboarding.
3. Explain the separate optional discovery and update choices.
   Show their current disclosures. Record only explicit answers using their
   consent tools. Skipping or declining leaves each disabled and does not block
   ordinary coordination. Discovery permission never starts collection; request
   and preview a scan separately. Do not collect inventory during setup.
4. Explain that the host asks once whether to Start Amadeus automatically.
   Guide the user through that host permission prompt; never edit trust
   records or bypass host controls. Ask them to start a fresh supported local
   chat. Verify Amadeus is available in that chat and
   `amadeus_onboarding_status`. Without that evidence say activation is unverified.
   Never treat starting Amadeus yourself outside the host as proof of approval.
5. Explain the per-task override: bypass Amadeus for this task. Simple questions
   stay lightweight. Substantive tasks use Amadeus and saved goals.

This setup currently supports manual desktop installation, not the
public universal plugin directory. Web/mobile activation is outside this release.
No telemetry, fault-intake service, or repository feedback channel is included.
