# Demo runbook

## Before opening the room

- Mac, iPhone, and Mentra Live are on the private router.
- External display is extended, not mirrored.
- Mac runtime has Accessibility permission.
- Flow 2 Pro appears as `Flow 2 Pro Dock ...` and has completed its connection nod.
- Mentra SDK and glasses software versions match.
- Only the team's Vexo band is connected.
- Red and blue QR badges decode at stage distance.
- All batteries are charged and automatic sleep is disabled.

## Start order

1. Connect the external display.
2. Start the Mac runtime and confirm its WebSocket address.
3. Double-tap and connect the team's Vexo band.
4. Join the iPhone and glasses to the private router.
5. Run `make mentra-bridge` on the Mac and wait for the glasses line to show battery
   (close the Mentra App on every phone first). Open the iPhone app.
6. Power and pair the Flow 2 Pro.
7. Confirm all four status indicators are green.
8. Run one digital and one physical rehearsal.

## Recovery

- Vexo failure: use the app's GRAB/THROW buttons.
- Mentra failure: use the app's manual target selector, or
  `curl -X POST 'http://127.0.0.1:8766/lock?target=mac'` on the Mac.
- Gimbal loss: press Reacquire and keep the selected badge facing the camera.
- Window failure: exit native fullscreen and refocus the prepared demo window.
