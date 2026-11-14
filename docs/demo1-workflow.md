# Demo 1 Workflow and Remaining Work

## Status

The published gesture intake was checked at commit `6ed58ed` on `codex/api`.
This document is an implementation assessment and a proposal, not a claim that
real window movement or a new gesture mapping has been implemented.

Demo 1 means moving the same live focused application window between two
extended displays attached to one Mac. It does not copy a screenshot, move a
whole desktop/Space, or send a window to another Mac.

## What works today

The HTTP API registers a band adapter, accepts `step`, `toggle`, and `select`,
validates inputs, deduplicates keyed retries, and returns `202 accepted`.
Events are buffered in memory. No window command is dispatched from that buffer.

The source band SDK and its official simulator are available. The API branch's
`RealVexoInput` is still a hardware adapter boundary, not a working classifier.
However, remote branch `vexoband` at `5031463` already provides a browser adapter,
gesture recognizer, `hub.js` HTTP client, and `serve.py` proxy. That code was
inspected read-only; it was not merged, changed, run, or hardware-validated here.

Its intended route is band BLE -> browser adapter -> same-origin `/hub` proxy
on the local dashboard server -> Mac API on port 8000. The proxy adds the session
token and forwards retry keys; this avoids requiring cross-origin browser access
to the API. The band client handles registration and posts unchanged event bodies.
Its default detector currently uses wrist tilt to emit `step` with -1 or 1; confirm
the physical gesture with the band owner, rather than changing the HTTP meaning.
The older optional adjustment mode and copied schema still mention `adjust`,
which the updated API rejects. The default mode does not send that event.

The separate WebSocket/iPhone route supports `window.capture` and `window.move`
messages, but uses the older `grab`/`throw` interaction. Its simulated window
controller stores a token and checks that the token exists; it does not move a
real window. The real `MacOSWindowController` methods still raise errors saying
AX window capture and movement are not implemented.

The iPhone shell has a coordinator and Mac WebSocket bridge, but its Mentra target
acquisition is mocked. The new HTTP `step`/`toggle`/`select` inputs do not feed that
coordinator. A photo upload does not automatically select a device.

## Minimal proposed route

```text
Band swipe -> band adapter -> Mac HTTP input -> Demo 1 dispatcher
           -> focused window and display lookup -> real window move
           -> position verification -> completed/failed status
```

The proposed business mapping is explicit and limited to Demo 1:

- `step` with `direction: -1`: move the focused window to the display on its left.
- `step` with `direction: 1`: move the focused window to the display on its right.
- Select the destination using the physical display arrangement, not an assumed
  display index or a rule that `1` always means the external monitor.
- With no display in that direction, return a clear no-target result rather than
  moving an arbitrary window or silently wrapping around.
- Keep `toggle` and `select` accepted, but do not silently give them window actions.
  Neither glasses-based selection nor the old grab/throw interaction is required
  for this minimal swipe-to-move demo.

This mapping is a proposal. The device-level contract defines physical direction;
it does not itself specify a window-management action.

## Missing components

| Component | Remaining work |
| --- | --- |
| Band integration | Connect the existing remote browser/proxy adapter to the Mac API and verify BLE ownership, reconnection, calibration, and left/right orientation end to end |
| Dispatcher | Implemented: `GestureDispatcher` maps an accepted `step` to `move_focused_window`, runs it off the event loop serialized, exposes the result at `GET /v1/band/events/{event_id}/result`, and relies on the existing retry-key buffer so a repeated delivery does not move again |
| Window lookup | Implemented: `MacOSWindowMover` checks `AXIsProcessTrusted` and reads the frontmost app's focused window frame. Still to confirm on hardware: clean rejection of unsupported/full-screen windows |
| Display selection | Implemented: `window_geometry` enumerates displays via `CGGetActiveDisplayList`/`CGDisplayBounds`, locates the source display by overlap, and selects the adjacent one from the real arrangement |
| Window executor | Implemented: `MacOSWindowMover` sets AX size+position via `window_geometry.target_frame` and re-reads the frame to verify it landed on the target display. Needs a two-display on-hardware run |
| Result feedback | Implemented at the executor level: `MoveResult` distinguishes `completed`/`no_target`/`failed` and verifies the final window position. Still to expose through the HTTP path (see Dispatcher) |

Glass capture, QR recognition, an iPhone coordinator, and voice are not needed for
the minimal route above. They become dependencies only if the team instead chooses
the fuller `LOOK -> GRAB -> LOOK -> THROW` profile in `TARGET.md`.

## Suggested implementation order

1. **(Done, pending on-hardware check with a second display.)** Move a real
   focused window between displays without band input, via the
   `bodyos-move-window --direction left|right` probe (`make move-left` /
   `make move-right`). Placement geometry lives in `window_geometry.py` and is
   unit-tested; the macOS Accessibility/Quartz calls live in `MacOSWindowMover`.
   The direction mapping, adjacent-display selection from the physical
   arrangement, no-target handling, and the missing-permission failure path are
   implemented. Still to confirm on hardware: a granted-permission move with a
   real external display attached, and behavior on unsupported/full-screen
   windows.
2. **(Done.)** Connect the HTTP event path to that executor through a small
   dispatcher. `POST /v1/band/events` with a `step` still returns `202 accepted`
   immediately; the swipe is then handed to `GestureDispatcher`, which runs the
   move off the event loop (serialized, one swipe at a time). The outcome is
   polled at `GET /v1/band/events/{event_id}/result`
   (`executing`/`completed`/`no_target`/`failed`). Retry safety is preserved: a
   duplicate `Idempotency-Key` is served from the buffer and does **not** move
   the window again; `toggle`/`select` are accepted but trigger no move.
3. Replace manual/mock event injection with the band owner's actual swipe adapter.
4. Add clear failure feedback and verify the full gesture-to-window demo.

For a successful demo, one swipe moves the intended live window once, a repeated
delivery does not move it again, a reverse swipe works when a display exists, and
missing permission/display/window produces an explicit failure.

## Diagram

Green nodes are implemented intake behavior. Amber nodes are proposed behavior or
integration not yet verified. Red nodes mark the execution gap and real move stub.
![Current intake and proposed Demo 1 workflow](diagrams/demo1-workflow.png)

The [Mermaid source](diagrams/demo1-workflow.mmd) has
[SVG](diagrams/demo1-workflow.svg) and [PNG](diagrams/demo1-workflow.png) renders,
plus an [editable Excalidraw scene](diagrams/demo1-workflow.excalidraw).
