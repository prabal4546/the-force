# Integration plan

## M0 - Contracts and mocks (30 minutes)

- Everyone can run `make check`.
- The iPhone shell can simulate every target and both gestures.
- The Mac runtime can start with `--simulate`.
- Both demo flows complete without hardware.

## M1 - One real capability each (90 minutes)

- Vexo: emit one real, filtered gesture event.
- Mentra: deliver one photo and decode every demo QR marker.
- Mac: capture and move one real frontmost window.
- Gimbal: connect through DockKit and perform a physical pan.

Each proof must enter through its module interface. Standalone scripts are kept
only as diagnostics.

## M2 - Half integrations (hour 3)

- Vexo event reaches the iPhone over the shared WebSocket.
- Mentra target selection reaches the coordinator.
- Manual iPhone selection can drive a real Mac window move.
- Manual iPhone selection can drive real gimbal tracking.

## M3 - Digital flow (hour 4)

```text
look at Mac -> GRAB -> look at display -> THROW -> exact window moves
```

Require five consecutive successful runs.

## M4 - Physical flow (hours 5-6)

```text
look at blue person -> GRAB -> look at gimbal -> THROW -> blue person tracked
```

Test both badges and maintain tracking for 30 seconds.

## M5 - Demo hardening

- Cold start in under three minutes.
- Clear disconnected, carrying, searching, tracking, success, and failure states.
- Keyboard/manual fallbacks remain available.
- Five complete rehearsals from a clean restart.
- Tag the known-good commit `demo-ready`.
