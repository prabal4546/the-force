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

## Vexo to Govee Table Lamp 2S

The Govee Table Lamp 2S (H8022) exposes Govee's local UDP LAN API. Add the lamp
in the Govee app, connect it to the same private network as the Mac, and enable
**LAN Control** in the lamp's device settings. Then run:

```bash
make govee-demo
```

The runtime discovers the H8022 automatically. If multicast discovery is
blocked, set `GOVEE_DEVICE_IP` to the lamp's LAN address before starting.

With the Vexo dashboard connected, a single tap toggles the lamp, a double tap
cycles colors, and left/right wrist steps change brightness by 10 percent. The
commands stay on the LAN; no Govee cloud API key is used.
