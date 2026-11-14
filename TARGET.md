# TARGET: The Force

> Shared product specification for the Mac window-transfer and physical
> attention-transfer demonstrations.

| Field | Target |
| --- | --- |
| Core interaction | `LOOK → GRAB → LOOK → THROW` |
| Coordinator | iPhone app |
| Inputs | Mentra Live gaze target + Vexo gesture |
| Executors | Mac window runtime + Insta360 Flow 2 Pro |
| Network model | Local-first on a private router |
| Demo backend | Mac WebSocket + iPhone photo receiver; no cloud required |

## Objective

Build one coherent product in which a person can grab either a live digital
window or another person’s identity, carry it through a physical gesture, and
throw it to an appropriate destination.

The target is not two disconnected hardware demonstrations. Both routes must
share the same interaction grammar, coordinator, state model, event contract,
status feedback, and failure handling.

## Contents

- [System model](#system-model)
- [Shared interaction](#shared-interaction)
- [Demo 1: Mac window transfer](#demo-1-mac-window-transfer)
- [Demo 2: Physical attention transfer](#demo-2-physical-attention-transfer)
- [Common infrastructure](#common-infrastructure-to-finish)
- [Recommended build order](#recommended-build-order)
- [Final acceptance criteria](#final-acceptance-criteria)

## System model

The two demos should not be built as separate products. They are two routes through the same interaction pipeline:

```text
Vexo gesture + Mentra gaze target
                 ↓
          iPhone coordinator
             ↙         ↘
      Mac window      Flow 2 Pro
```

The iPhone decides what the gesture means. The Mac and gimbal are executors.

### Shared interaction

Your universal grammar is:

```text
LOOK at source → GRAB → LOOK at destination → THROW
```

The iPhone maintains:

```text
IDLE
→ ACQUIRING_SOURCE
→ CARRYING(window or person)
→ ACQUIRING_DESTINATION
→ EXECUTING
→ IDLE or TRACKING
```

Both demos share:

- Vexo gesture recognition
- Mentra target recognition
- iPhone state machine
- Mac–iPhone WebSocket
- Status and failure UI

Only the final executor changes.

---

## Demo 1: Mac window transfer

### What the audience sees

```text
1. Chrome is open on the Mac.
2. User looks at the Mac marker.
3. User performs GRAB.
4. Vexo turns yellow: the window is being carried.
5. User looks at the external-display marker.
6. User performs THROW.
7. The exact Chrome window moves onto the external display.
8. Vexo turns green.
```

It is the same live window—not a screenshot or video stream.

### Complete technical sequence

#### 1. GRAB is detected

Vexo sends IMU data to the Mac over Bluetooth.

The Mac recognizes `GRAB` and immediately:

- Captures a candidate reference to the current frontmost window.
- Sends the gesture and candidate window token to the iPhone.

Recommended message:

```json
{
  "version": 1,
  "id": "gesture-14",
  "type": "gesture.detected",
  "gesture": "grab",
  "confidence": 0.93,
  "candidateWindowToken": "window-82F4"
}
```

Capturing immediately is important. If the user focuses another application while Mentra is processing the photo, you still retain the window that was frontmost at GRAB time.

#### 2. Mentra identifies the source

The iPhone receives `GRAB` and requests a Mentra photo.

Mentra uploads the image to the iPhone’s local photo receiver. Vision scans it and finds:

```text
bodyos://device/mac
```

The coordinator now accepts the candidate window token and enters:

```text
CARRYING(window-82F4)
```

If Mentra sees a person instead, the unused candidate window is discarded.

#### 3. THROW is detected

The user looks at the marker attached to the external display and performs `THROW`.

The Mac sends the gesture to the iPhone. The iPhone requests another Mentra photo and finds:

```text
bodyos://device/external-display
```

The coordinator verifies:

```text
carried payload = window
destination = externalDisplay
```

It sends:

```json
{
  "version": 1,
  "id": "command-21",
  "type": "window.move",
  "token": "window-82F4",
  "destination": "externalDisplay"
}
```

#### 4. Mac moves the window

The Mac runtime:

- Looks up the retained accessibility window.
- Finds the non-primary display.
- Converts its coordinates to Accessibility coordinates.
- Sets the window position.
- Resizes it to fill the external display.
- Raises the application.
- Reports success.

```json
{
  "version": 1,
  "replyTo": "command-21",
  "type": "window.moved",
  "token": "window-82F4",
  "success": true
}
```

### What needs to be built

#### Real Vexo adapter

Existing stub:

```text
services/mac-runtime/src/bodyos_mac/vexo_adapter.py
```

Build:

- Connect to the exact configured band number.
- Stream accelerometer and gyroscope data.
- Segment individual gestures.
- Recognize `GRAB` and `THROW`.
- Apply confidence thresholds and cooldowns.
- Control yellow, green, and red LED feedback.
- Keep keyboard `G`/`T` fallback.

Start with double-tap or an easy gesture. Add custom gesture classification only after the complete flow works.

#### Real Mac window controller

Existing stub:

```text
services/mac-runtime/src/bodyos_mac/window_controller.py
```

Build:

- Check Accessibility permission.
- Get the frontmost application.
- Get its focused accessibility window.
- Retain the live `AXUIElement` behind a UUID token.
- Enumerate connected displays.
- Move and resize the retained window.
- Detect closed windows and disconnected displays.

You need this Mac process because an iPhone cannot directly manipulate another computer’s application windows.

You do not need Screen Recording permission because you are moving a window, not reading its pixels.

#### iPhone WebSocket client

Add:

```text
apps/ios/Modules/MacBridge/MacWebSocketClient.swift
```

Build:

- Connect to `ws://<mac-ip>:8765`.
- Decode gestures and responses.
- Send window and LED commands.
- Reconnect after the Mac runtime restarts.
- Correlate responses using `id` and `replyTo`.

### Mac acceptance test

The strongest test is:

1. Focus Chrome.
2. GRAB.
3. Focus Notes.
4. THROW.
5. Chrome—not Notes—moves to the external display.

That proves you retained the grabbed window rather than looking up the current window during THROW.

---

## Demo 2: Physical attention transfer

### What the audience sees

```text
1. Red and blue people stand near the stage.
2. User looks at the blue person.
3. User performs GRAB.
4. Vexo turns yellow.
5. User looks at the Flow 2 Pro marker.
6. User performs THROW.
7. The gimbal scans the room.
8. It finds the blue person and begins following them.
9. The wearer turns away, but the delegated attention continues tracking.
```

### Why the people need badges

Default person tracking may choose whichever person is most prominent. Your interaction requires identity:

```text
“I grabbed the blue person, so track that same person.”
```

Give each person a large QR badge:

```text
bodyos://person/red
bodyos://person/blue
```

The same badge is identifiable from:

- Mentra’s viewpoint during GRAB
- The gimbal-mounted iPhone during acquisition

That avoids face recognition and cross-camera identity matching.

### Complete technical sequence

#### 1. GRAB is detected

The user looks at the blue badge and performs `GRAB`.

Vexo reports the gesture through the Mac WebSocket. The iPhone asks Mentra for a photo.

Vision decodes:

```text
bodyos://person/blue
```

The coordinator enters:

```text
CARRYING(attention(personBlue))
```

#### 2. THROW is detected

The user looks at the marker attached to the gimbal and performs `THROW`.

Mentra captures another image and decodes:

```text
bodyos://device/gimbal
```

The coordinator verifies:

```text
carried payload = personBlue
destination = gimbal
```

It calls:

```swift
try await dockController.acquireAndTrack(person: .personBlue)
```

#### 3. Gimbal searches

The iPhone disables DockKit’s automatic system tracker and begins a controlled search:

```text
center → left → center → right
```

At every position, its camera pipeline searches for the blue QR code.

It completely ignores the red badge.

#### 4. Gimbal acquires the target

Once Vision detects the blue QR, the app obtains its normalized bounding box:

```swift
DockAccessory.Observation(
    identifier: blueTargetID,
    type: .object,
    rect: badgeBoundingBox
)
```

It supplies that observation to DockKit roughly 10–30 times per second. DockKit turns the bounding boxes into smooth physical pan and tilt movement.

For performance:

1. Use QR recognition to establish identity.
2. Start `VNTrackObjectRequest` on the acquired rectangle.
3. Feed the tracked rectangle to DockKit.
4. Periodically revalidate the QR.
5. If tracking fails, return to the scan pattern.

#### 5. Tracking continues

The coordinator enters:

```text
TRACKING(personBlue)
```

If the badge disappears:

```text
TRACKING → LOST → REACQUIRING → TRACKING
```

### What needs to be built

#### Mentra integration

Existing boundary:

```text
apps/ios/Modules/MentraTargeting/
```

Add:

```text
MentraTargetSource.swift
LocalPhotoUploadServer.swift
MarkerDecoder.swift
```

Build:

- Add `MentraBluetoothSDK`.
- Connect and reconnect to Mentra Live.
- Trigger one photo on GRAB or THROW.
- Run the local HTTP photo receiver on the iPhone.
- Decode QR markers with Vision.
- Return exactly one `TargetID`.
- Reject missing or ambiguous markers.
- Preserve a manual target selector.

The local HTTP endpoint is needed because Mentra delivers captured photos to a webhook. It can run on the iPhone; you do not need a cloud backend.

#### Real DockKit controller

Existing boundary:

```text
apps/ios/Modules/GimbalTracking/
```

Add:

```text
DockKitController.swift
GimbalSearch.swift
BadgeDetector.swift
BadgeTracker.swift
CameraPipeline.swift
```

Build:

- Detect when Flow 2 Pro connects.
- Disable system tracking.
- Start the iPhone camera.
- Control search movement.
- Decode the requested badge.
- Supply custom DockKit observations.
- Detect loss and reacquire.
- Expose manual red/blue tracking buttons.

You use DockKit because it owns the Flow 2 Pro motor connection and converts tracking observations into smooth movement.

#### Coordinator integration

The current coordinator is mocked. Connect its commands to real adapters:

```text
requestTargetCapture → MentraTargetSource
captureFrontmostWindow → MacBridge
moveWindow → MacBridge
trackPerson → DockKitController
setVexoLED → MacBridge
```

The coordinator should remain free of Mentra, Vision, DockKit, and Bluetooth implementation details.

---

## Common infrastructure to finish

### 1. Private router

Connect:

- Mac
- iPhone
- Mentra Live Wi-Fi

Flow 2 Pro and Vexo use Bluetooth, but the Mac–iPhone WebSocket and Mentra photo upload use the private LAN.

Use stable IPs if possible:

```text
Mac:    192.168.8.10
iPhone: 192.168.8.11
```

### 2. Local services

You need two small local network endpoints:

```text
Mac WebSocket:
ws://192.168.8.10:8765

Mentra photo receiver:
http://192.168.8.11:8787/mentra/photo
```

That is all the “backend” needed. No cloud deployment, database, accounts, or LLM.

### 3. Physical markers

Print and test:

```text
bodyos://device/mac
bodyos://device/external-display
bodyos://device/gimbal
bodyos://person/red
bodyos://person/blue
```

Device markers can go on their bezels or stands. Person markers should be approximately 15–20 cm wide and worn on the upper chest.

### 4. Status UI

The iPhone app should show:

```text
Mentra: Connected
Vexo: Connected
Mac runtime: Connected
Flow 2 Pro: Connected

State: Carrying personBlue
Last target: gimbal
Tracking: searching
```

Never require console logs to understand why the demo stopped.

---

## Recommended build order

### Step 1: Finish Mac–iPhone communication

- Run the simulated Mac runtime.
- Implement the iPhone WebSocket client.
- Verify terminal `g` and `t` reach the iPhone.
- Verify mock window commands return responses.

This validates the product backbone.

### Step 2: Complete the Mac window proof

- Implement real Accessibility capture and movement.
- Drive it with keyboard GRAB/THROW.
- Preserve the exact captured window.
- Perform five successful moves.

This is the simplest complete output.

### Step 3: Complete manual gimbal tracking

- Connect Flow 2 Pro.
- Select red or blue using an app button.
- Press “Find and Track.”
- Search and follow the correct badge.

Do this before involving Mentra or Vexo.

### Step 4: Connect real Vexo

- Replace keyboard gesture events.
- Keep keyboard fallback.
- Add LED feedback and confidence thresholds.

### Step 5: Connect real Mentra

- Capture a photo.
- Deliver it to the iPhone.
- Decode every marker.
- Replace the manual target selector.

### Step 6: Run the complete routes

```text
Mac + GRAB + display + THROW
→ window moves

personBlue + GRAB + gimbal + THROW
→ blue person tracked
```

### Step 7: Harden only after both work

- Reconnection
- Gesture cooldown
- Tracking reacquisition
- Clear errors
- Cold-start checklist
- Five consecutive rehearsals

The crucial engineering strategy is to make the two outputs work manually first. After that, Mentra and Vexo are replacements for buttons—not additional mysteries mixed into window and gimbal debugging.

---

## Final acceptance criteria

The product is demo-ready only when all of the following are true:

### Shared system

- The iPhone shows live connection state for Mentra, Vexo, the Mac runtime, and
  Flow 2 Pro.
- Manual target and gesture controls remain available as recovery paths.
- Invalid source/destination combinations fail visibly and do not trigger an
  unrelated executor.
- The complete system can cold-start in under three minutes.

### Mac route

- The frontmost window is captured at GRAB time.
- Changing focus after GRAB does not change which window is moved.
- THROW to `externalDisplay` moves and sizes the exact live window in under one
  second.
- Closing the captured window or disconnecting the display produces a visible
  failure instead of moving a different window.

### Gimbal route

- Red and blue badges are distinguished with both people visible.
- The requested person is acquired within five seconds.
- The gimbal never intentionally locks onto the non-selected badge.
- Tracking continues for 30 seconds and reacquires after a brief loss.

### Rehearsal

- Both routes succeed five consecutive times from `main`.
- The known-good commit is tagged `demo-ready`.
