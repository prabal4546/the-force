# The Force

The Force is a local-first demo of one interaction grammar:

```text
LOOK -> GRAB -> LOOK -> THROW
```

The same gesture can move a live Mac window to an external display or hand a
selected person to an Insta360 Flow 2 Pro for tracking.

## System map

```text
Mentra Live -- BLE commands + LAN photo --> iPhone coordinator -- DockKit --> Flow 2 Pro
                                                  ^
                                                  |
                                             WebSocket (LAN)
                                                  |
Vexo band -------------------- BLE ----------> Mac runtime ---- AX API ----> Mac windows
```

There is no cloud backend in the demo. The iPhone owns product state. The Mac
runtime bridges Vexo gestures and performs Mac-only window operations.

## Ownership

| Owner | Primary area | Contract they publish |
| --- | --- | --- |
| Vexo owner | `services/mac-runtime/src/bodyos_mac/vexo_adapter.py` | `gesture.detected` |
| Mentra owner | `apps/ios/Modules/MentraTargeting/` | `target.detected` |
| Mac-window owner | `services/mac-runtime/src/bodyos_mac/window_controller.py` | `window.captured`, `window.moved` |
| Gimbal/iPhone owner | `apps/ios/Modules/GimbalTracking/` and `ProductCore/` | coordinator state, `tracking.state` |

## Start here

1. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) and
   [`docs/architecture.md`](docs/architecture.md).
2. Copy `.env.example` to `.env` and fill in your team's own values. Never
   commit `.env`.
3. Run `make check` before opening a pull request.
4. Start with the mocked vertical slice before connecting hardware:

   ```bash
   make mac-setup
   make mac-sim
   ```

5. For the iPhone app, install XcodeGen, then:

   ```bash
   cd apps/ios
   xcodegen generate
   open BodyOS.xcodeproj
   ```

6. In the app, use `127.0.0.1` when running in the simulator. On a physical
   iPhone, enter the Mac's LAN IP, then tap **Connect Mac**.

## Integrated smoke test

Run `make mac-sim`, connect the iPhone shell, and exercise the Mac route:

1. Select **Mac**, then trigger **GRAB** in the app or type `g` in the Mac
   simulator. The runtime captures a window token.
2. Select **External Display**, then trigger **THROW** or type `t`. The same
   token is sent back and the runtime reports that the window moved.
3. Select **Blue Person**, trigger **GRAB**, select **Gimbal**, and trigger
   **THROW** to exercise the mocked DockKit route.

The event log in the iPhone shell shows every coordinator transition and
hardware command. This gives all four owners one shared integration surface
while the Mentra and DockKit adapters are replaced with real hardware.

The iOS shell contains manual target and gesture controls. Keep these controls
working even after real hardware is connected; they are the integration and
demo fallback.

## Repository layout

```text
apps/ios/                  SwiftUI shell and iPhone-side modules
services/mac-runtime/      Vexo bridge and Mac window controller
shared/protocol/           Versioned JSON message contract
docs/                      Architecture, milestones, and runbook
vendor/vexo-open-kit/      Unmodified Vexo reference kit
scripts/                   Repository checks
```

## Definition of done

A feature is done only when it is merged into `main`, exercised through the
shared contract, and demonstrated through the product shell. A local hardware
script by itself is a proof, not an integrated feature.
