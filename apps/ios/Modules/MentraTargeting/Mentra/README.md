# Mentra targeting

**What is the wearer looking at?** Mentra Live takes a photo, the iPhone reads the QR marker nearest
the middle of it, and returns a `TargetID`.

    LOOK + grab --> captureTarget() --> photo from the glasses --> QR markers in it --> .mac / .personBlue / ...

`MentraTargetSource` implements `TargetSource` (in `../MentraTargeting.swift`), so the app swaps
`MockTargetSource` for it and nothing else changes. Not wired into `DemoViewModel` yet.

## Status

| Part | State |
|---|---|
| Compiles in the app with `MentraBluetoothSDK` 3.4.0 (see `project.yml`) | Done, iOS simulator build |
| Marker texts, picker, "not a photo" error (`Tests/MentraMarkerTests.swift`) | Tests pass in the simulator |
| Vision QR decode | Passes on macOS against the printed markers in `docs/mentra-markers/`. The two Vision tests **fail in the iOS simulator** ("Could not create inference context"): Vision's detector does not run there. Run them on a real iPhone. |
| Real glasses (pairing, photo, upload) | **Not tested.** Written against the SDK 3.4.0 source. The glasses must run software 3.4.0 too. |
| Upload parser and receiver | No tests yet |

## Using it

```swift
let glasses = MentraGlasses()                       // Bluetooth link; show glasses.status in the UI
let photos = MentraPhotoSource(glasses: glasses)     // photo -> this iPhone over Wi-Fi (Bluetooth fallback)
let targets: TargetSource = MentraTargetSource(photos: photos)   // or MockTargetSource()

// First run: glasses.scan(), show glasses.found, the person taps theirs: glasses.connect(device)
// Later runs: glasses.connectSaved()
// During the demo: photos.keepWarm()   (faster photos; costs battery)

let target = try await targets.captureTarget()
```

Pairing: press the glasses' power button **3 times** (2-minute window; they say a 4-character code).
`Device.pairingCode` holds that code, so show it in the list. The scan never connects by itself:
other teams' glasses may be in the room.

## How the photo gets to the iPhone

Bluetooth carries the command only. The glasses upload the JPEG **over Wi-Fi** to
`GlassesMediaReceiver` on the iPhone (`http://<iPhone's Wi-Fi address>:8787/upload`, or `/mentra/photo` as in TARGET.md). If Wi-Fi does not
work, the SDK brings it over Bluetooth instead (a few seconds slower). Put the glasses on the same
private router as the iPhone. The Info.plist keys this needs are already in `project.yml`.

## Files

| File | What it does |
|---|---|
| `TargetMarker.swift` | QR text <-> `TargetID` for the five markers (exact texts only) |
| `MarkerDecoder.swift` | Finds QR codes with Apple Vision, on the device |
| `TargetPicker.swift` | Several markers in view: nearest the middle wins; a much bigger one wins a near-tie |
| `MentraGlasses.swift` | Scan, pick, connect, reconnect; publishes `status` |
| `GlassesMediaReceiver.swift`, `UploadParsing.swift` | Small HTTP server (port 8787) the glasses upload to |
| `PhotoSource.swift` | `MentraPhotoSource`: request a photo with this iPhone as the upload address; camera warm-up |
| `MentraTargetSource.swift` | The real `TargetSource`: photo, decode, pick; 2 photos before "no marker" |
| `CaptureLog.swift` | Saves every capture and what was read, in Documents/MentraCaptures; `hitRate()` |
| `GlassesRecorder.swift` | Record a clip on the glasses and bring it to the iPhone |
| `MockTargetSource.swift` | Scripted answers; `setNext(_:)`, `failNext()` for buttons |
| `MentraInputError.swift` | The errors, with messages written for the stage |

Markers to print: `docs/mentra-markers/*.png`. Print each at least about 20 cm wide for 3-4 m.
Mentra Live gives no raw accelerometer or gyroscope (only head up/down), so motion comes from the Vexo band.
