# Mentra Bridge

Mentra Live to target lock over the **Mentra Bluetooth SDK only**. No Mentra App, no phone,
no cloud, no Wi-Fi: this Mac app talks to the glasses directly.

    LOOK --> photo over Bluetooth --> QR marker nearest the middle --> target.detected --> Mac runtime --> iPhone

It replaces `tools/mentra-miniapp` as the source of `target.detected`. The miniapp relays each
photo through the Mentra App and took about 20 s per lock; this takes about 3 s.

## Run

```bash
make mac-sim            # or mac-demo: the Mac runtime on ws://127.0.0.1:8765
make mentra-bridge      # builds and opens "Mentra Bridge.app"
```

Needs macOS 13+ and Swift 5.9+ (Xcode or the command line tools). The first build fetches
the SDK from GitHub. Quit the app before building again. Always open the `.app`, not the
bare binary: macOS reads the Bluetooth permission text from the bundle.

First run, once per Mac:

1. Turn the glasses on. Close the Mentra App on any phone that knows them, or the phone
   takes the Bluetooth link and the Mac never connects.
2. Click **Scan**, allow Bluetooth, pick your glasses, click **Pair**. The list shows each
   pair's code; other teams' glasses may be in the room.

After that the bridge finds the same glasses by name on every launch and keeps retrying
while they are away. The window shows the glasses, the Mac runtime link, and the last photo
with what was read from it.

## Locking a target

Look at a marker from `docs/mentra-markers/`, then any of:

- press the button on the glasses
- **Capture target** in the window (Return)
- `curl -X POST http://127.0.0.1:8766/capture`
- tick **Auto-lock**: photo after photo, so looking at a marker is enough

A photo with no marker leaves the current lock alone. With several markers in view, the one
nearest the middle of the photo wins. The iPhone app shows `Mentra locked: ...` and uses
that target for the next GRAB or THROW.

## Speed

Measured 2026-11-14, glasses `Mentra_Live_E883`, SDK 3.5.0-dev.1416, request to decoded target:

| Setting | Photo | Time |
| --- | --- | --- |
| Sharp (default) | 1280 x 960, high compression | 2.9 to 3.8 s |
| Fast | 640 x 480, high compression | 1.8 to 2.0 s |
| 1280 x 960, medium compression | | 3.5 to 3.7 s |
| 1280 x 960, no compression | | 5.9 to 6.7 s |
| Sharp, **Keep camera warm** off | | 4.7 to 5.1 s |
| Auto-lock, Sharp | one photo about every 3.2 s | |

Almost all of the wait is the photo crossing Bluetooth, so bytes are what cost time.
Two things keep it short:

- `localFile: true` on the photo request: the SDK pulls the JPEG straight over Bluetooth
  into a file. A webhook request first tries a Wi-Fi upload and only then falls back to
  Bluetooth; that detour is the likely cause of the 7 s the webhook version took.
- **Keep camera warm** holds the camera open between photos and saves about 2 s a photo.
  It costs glasses battery (55% to 43% in 20 minutes of test captures); untick it or quit
  the bridge when idle. The first photo after changing
  the size is slow because the camera reconfigures.

Fast has a quarter of the pixels, so a marker has to be about twice as close. Not yet
measured: the farthest distance each setting reads a 20 cm marker from. Check it on stage.

## Control endpoint

Loopback only, `http://127.0.0.1:8766` (the Mac runtime owns 8765):

| Request | Does |
| --- | --- |
| `POST /capture[?size=low\|medium][&compress=none\|low\|medium\|high]` | One photo; answers with target, time and size |
| `GET /status` | Glasses, runtime link, settings, last capture |
| `GET /photo` | The last photo (JPEG) |
| `POST /connect[?name=Mentra_Live_XXXX]` | Reconnect, or connect to the named glasses |
| `POST /auto?on=1\|0`, `POST /warm?on=1\|0` | Auto-lock, camera warm-up |
| `POST /lock?target=mac` | Lock a target by hand (recovery path) |
| `POST /runtime?address=host[:port]` | Where the Mac runtime is |

## Files

| File | What it does |
| --- | --- |
| `Sources/MentraBridgeCore/Markers.swift` | Marker texts, Vision QR decode, which marker wins |
| `Sources/MentraBridgeCore/Wire.swift` | The `target.detected` message; small HTTP parser |
| `Sources/MentraBridge/TargetCapture.swift` | Photo request, decode, publish; auto-lock and warm-up loops |
| `Sources/MentraBridge/RuntimeLink.swift` | WebSocket to the Mac runtime, reconnects, resends the lock |
| `Sources/MentraBridge/ControlServer.swift` | The loopback endpoint |
| `Sources/MentraBridge/App.swift` | Window, pairing, reconnect by name |

## Tests

```bash
make mentra-bridge-check
```

Covers marker texts, Vision decoding of the five printed markers, the picker, the wire
message and the HTTP parser. No glasses needed. The tests use Swift Testing, which needs
full Xcode; the Makefile points `DEVELOPER_DIR` at it.

## Known limits

- After a force quit the glasses can take about 30 s to accept a new connection. Quit normally.
- Live video still needs a glasses software update and Wi-Fi; this bridge is photos only.
