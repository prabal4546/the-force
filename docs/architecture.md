# Architecture

## Decision

The iPhone is the single coordinator. This prevents the glasses, bracelet,
gimbal, and Mac from each maintaining a different interpretation of the demo.

The Mac runtime is intentionally not a second coordinator. It owns two local
capabilities only:

1. turn Vexo sensor data into gesture events;
2. capture and move live Mac windows.

## Runtime connections

| Link | Transport | Purpose |
| --- | --- | --- |
| Mentra Live -> iPhone | BLE | connection and capture commands |
| Mentra Live -> iPhone | private LAN HTTP | captured photo upload |
| Vexo -> Mac | BLE | motion, events, and LED feedback |
| Mac <-> iPhone | private LAN WebSocket | gestures, window commands, status |
| iPhone -> Flow 2 Pro | DockKit | search, pan/tilt, and custom tracking |

## Product state

```text
IDLE
  -> ACQUIRING_SOURCE
  -> CARRYING(windowToken | personID)
  -> ACQUIRING_DESTINATION
  -> EXECUTING
  -> IDLE | TRACKING | ERROR
```

`GRAB` asks Mentra for a photo and resolves the source under the wearer's gaze.
`THROW` asks for a second photo and resolves the destination. The coordinator
routes the carried payload only when the source/destination pair is valid.

Valid routes:

| Payload | Destination | Action |
| --- | --- | --- |
| live Mac window token | `externalDisplay` | tell Mac runtime to move it |
| `personRed` or `personBlue` | `gimbal` | tell DockKit to acquire and track it |

## Reliability boundaries

- Every hardware module has a mock.
- Messages include a protocol version and correlation identifier.
- The coordinator ignores duplicate message identifiers.
- A gesture is debounced while a Mentra capture is pending.
- Window identity is captured at GRAB time, not looked up again at THROW time.
- Gimbal tracking selects the requested QR payload and ignores other badges.
