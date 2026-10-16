# Amadeus 0.3.11 - generic local Windows UI Automation

Amadeus 0.3.11 adds one generic Windows UI Automation engine shared by the
Codex and Claude packages. ZEISS INSPECT remains the first compatibility
fixture, but the runtime is not tied to ZEISS or any other application.

## What changed

- Exact Windows application and window selectors can be inspected locally.
- Host AIs can focus controls, invoke buttons, enter text through
  `ValuePattern`, select items, toggle controls, and expand or collapse controls.
- Explicit Windows UI plan tasks route to ordinary local software before
  Cursor, Codex, or Claude workers.
- Unsupported controls and unavailable UI Automation stop with a local receipt
  instead of silently purchasing another model turn.
- The same generated runtime is packaged for Codex and Claude marketplace
  installations.

## Compatibility

Windows applications must expose the relevant controls through Microsoft's UI
Automation accessibility interfaces. Custom canvases and some 3D interfaces may
still require visual computer use. The release tests the generic engine with
synthetic fixtures; it does not operate a live ZEISS installation or machine.

## Updating

Use the normal Codex or Claude marketplace update flow. No separate Claude
Desktop ZIP upload is required.
