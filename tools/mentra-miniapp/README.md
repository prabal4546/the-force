# The Force Mentra Miniapp

> Fallback path. `tools/mentra-bridge` publishes the same `target.detected` from the Mac over the
> Bluetooth SDK alone in about 3 s; this miniapp goes through the Mentra App and takes about 20 s.
> Do not run both against the same glasses: only one of the Mac and the phone can hold the link.

This is the Mentra App integration for glasses photo capture. It does
not use the retired cloud SDK or the old **Camera → Use cloud server** setting.
The miniapp runs inside the standard Mentra phone app and asks the glasses to
send a photo through the phone using Mentra's BLE relay.

## Run on a phone

The Mac and phone must be on the same Wi-Fi or hotspot while loading the dev
build. The glasses only need to be paired and connected in the Mentra App.

```bash
cd tools/mentra-miniapp
npm install
npm run typecheck
npm run dev
```

The terminal prints a QR code. In the Mentra App open:

**Settings → Developer settings → Mini App Development → Scan Mini App QR Code**

Optionally set `MENTRA_PUBLIC_MAC_HOST=<Mac LAN IP>:8765` before `npm run dev`,
or enter that address in the miniapp. Scan the QR, accept camera access, and
open **The Force Target Capture**. Aim at one of the QR markers in
`docs/mentra-markers/`, then tap **Capture from glasses**. The miniapp decodes
the marker and sends `target.detected` to the Mac runtime. The iPhone
coordinator receives that target before the next Vexo gesture. If the glasses
expose button events to miniapps, pressing the glasses button triggers the same
capture path.

`transferMethod: "ble"` is intentional: it avoids requiring the retired
cloud-server camera setting and relays the captured image through the phone.

## What this proves

- The current Mentra App can load The Force as a local miniapp.
- The miniapp can command the physical glasses camera.
- A real photo reaches the phone and is displayed from Mentra's returned URL.
- A BodyOS target marker in the photo becomes the active target used by Vexo.

Target selection is deliberately marker-based for demo reliability. It is the
replaceable boundary for a learned visual detector later.
