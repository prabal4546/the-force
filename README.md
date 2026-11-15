# The Force

## Device input API (current API branch)

The Python API accepts device registration, band events, and glasses photos.
It is independent of the older mocked iPhone-coordinator flow below. It does not
connect Bluetooth hardware or execute window movement yet.

```bash
make mac-setup
make api PYTHON=.venv/bin/python
```

Open `http://127.0.0.1:8000/docs` for request/response schemas and interactive
examples. See [`docs/api.md`](docs/api.md) for the three input contracts,
device status, photo retrieval, LAN setup, and client examples.
The current teammate payloads use `POST /v1/band/events?device_id=...` without
renaming `type`, `direction`, or `text`. Gestures are `step` (left/right swipe),
`toggle` (single tap), and `select` (double tap); `adjust` has been removed. See
[`docs/sdk-compatibility.md`](docs/sdk-compatibility.md) for SDK capabilities,
simulator coverage, and differences from the remote target specification.

Run `make check PYTHON=.venv/bin/python` after installing the dependencies.
Agents should start with [`AGENTS.md`](AGENTS.md).

## iPhone-coordinator demo

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

## Vexo to real Mac window

Run these in separate terminals:

```bash
make mac-setup
make mac-demo
```

```bash
make band
```

Open `http://localhost:8001`, connect and calibrate Vexo, then connect the
iPhone app to the Mac runtime. Focus the Mac window you want, select **Mac** on
the phone and single-tap Vexo to GRAB. Select **External Display** on the phone
and double-tap Vexo to THROW. The dashboard still records the original band
events in the HTTP API when that API is running.

If the selected app exposes a non-movable window, use the presentation fallback:
focus Keynote, PowerPoint, or Google Slides and use left/right Vexo wrist steps
to send real macOS arrow keys through the same coordinator.

## Mentra target lock

`make mentra-bridge` opens a Mac app that connects to Mentra Live directly over the
Mentra Bluetooth SDK (no Mentra App, no phone, no Wi-Fi). Look at a marker from
`docs/mentra-markers/` and press the glasses button, or tick **Auto-lock**: the photo
comes over Bluetooth, the QR marker is read on the Mac, and `target.detected` goes to
the Mac runtime and on to the iPhone in about 3 seconds. See
[`tools/mentra-bridge/README.md`](tools/mentra-bridge/README.md).

## Vexo to Govee lamp

For a compact physical-device demo, the Mac runtime can route the same Vexo
events to a Govee Table Lamp 2S (H8022) over Govee's local LAN API. Enable LAN
Control for the lamp in the Govee app, then run `make govee-demo`. Single tap
toggles power, double tap cycles color, and left/right wrist steps adjust
brightness. See `services/mac-runtime/README.md` for setup details.

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
tools/mentra-glasses-tool/ Mentra Live capture on the Mac: photos, video, every video frame -> data/ and the device API
tools/mentra-bridge/        Mentra Live target lock on the Mac over the Bluetooth SDK only: photo -> QR marker -> target.detected (about 3 s)
tools/mentra-miniapp/       Fallback: Mentra App miniapp, photo through the phone's BLE relay (about 20 s)
```

## Definition of done

A feature is done only when it is merged into `main`, exercised through the
shared contract, and demonstrated through the product shell. A local hardware
script by itself is a proof, not an integrated feature.
