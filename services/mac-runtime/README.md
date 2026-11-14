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

The real window controller should use `NSWorkspace.frontmostApplication`,
`AXUIElement`, and `NSScreen`. It needs macOS Accessibility permission. Retain
the selected AX window at capture time so a focus change before THROW does not
change which window moves.
