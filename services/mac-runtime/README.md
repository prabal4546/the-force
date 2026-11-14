# Mac runtime

The Mac runtime is a local capability service, not another AI agent. It reads
Vexo events, publishes gestures, retains the exact grabbed accessibility window,
and moves that window to the connected external display when commanded.

## Simulated run

From the repository root:

```bash
make mac-setup
make mac-sim
```

The simulated runtime hosts a WebSocket on `ws://0.0.0.0:8765` and accepts
`g`/`t` in the terminal as GRAB/THROW events.

## Demo 1: real window move (standalone)

Step 1 of the Demo 1 plan is to move the focused window between displays with no
band, iPhone, or glasses in the loop. This proves real window movement on the
hardware before the gesture dispatcher is wired in.

```bash
make mac-move-setup          # installs the pyobjc 'mac' extra
make move-right              # move the focused window to the display on its right
make move-left               # ...or to the left
```

The first real run needs macOS Accessibility permission: System Settings >
Privacy & Security > Accessibility, enable the terminal (or Python) running the
command, then rerun. Without permission the command prints a `[failed]` line
explaining this and exits non-zero. With a single display it prints
`[no_target]`. Add `--simulate` to exercise the placement logic with an
in-memory two-display model and no permission.

Placement geometry (which display is adjacent, where the window lands, clamping
to fit) lives in `window_geometry.py` and is unit-tested without macOS. The
pyobjc Accessibility/Quartz calls live in `MacOSWindowMover` /
`window_controller._AXBackend`.

## Demo 1: gesture -> window move (full path)

The device API (port 8000) is what moves windows for Demo 1. A band `step` event
is accepted with `202`, then `GestureDispatcher` moves the focused window to the
adjacent display and records the outcome.

```bash
make mac-move-setup     # once: pyobjc 'mac' extra
make api                # real moves (needs Accessibility permission)
# ...or exercise the wiring with an in-memory two-display model:
make api-sim
```

Then, with a band registered as `device_type: band`:

```bash
# right swipe -> move focused window to the display on its right
curl -X POST 'http://127.0.0.1:8000/v1/band/events?device_id=band-1' \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: swipe-1' \
  -d '{"type":"step","direction":1}'
# poll the result (status: executing -> completed | no_target | failed)
curl 'http://127.0.0.1:8000/v1/band/events/swipe-1/result?device_id=band-1'
```

A repeated delivery with the same `Idempotency-Key` does not move the window
twice; `toggle`/`select` move nothing. See [`../../docs/api.md`](../../docs/api.md)
for the full contract.

## Real-hardware work

The Vexo adapter must read `VEXO_BAND_NUMBER` from `.env` or the environment and
connect only to that exact band. Do not scan for the first available band. The
vendored reference kit lives at `vendor/vexo-open-kit`.

To use the real macOS window controller with the dashboard's Vexo input:

```bash
make mac-setup
make mac-demo
```

The first GRAB prompts for macOS Accessibility permission. Grant the terminal or
runner under **System Settings > Privacy & Security > Accessibility**, restart
the runtime, and try again. The controller retains the selected AX window at
GRAB time, so a focus change before THROW does not change which window moves.

For the reliable fallback demo, keep Keynote, PowerPoint, or Google Slides in
the foreground. A left/right wrist step on the Vexo dashboard posts the matching
macOS arrow key and changes slides. This does not require the focused window to
be movable.

Keep the dashboard in the background and focus the window you want before the
single-tap GRAB. The external monitor must use extended desktop, not mirroring.
