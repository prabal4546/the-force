# SDK Compatibility and Integration Boundaries

## Scope and source of truth

This API branch implements device registration and input reception only. It does
not connect hardware, run a gesture classifier, trigger capture, transcribe audio,
synthesize speech, recognize targets, or move a window. All code and documentation
are maintained in English.

Sources checked:

- The vendored [Vexo Open SDK](../vendor/vexo-open-kit/python/vexo_open/band.py),
  its [simulator](../vendor/vexo-open-kit/python/vexo_open/transports/sim.py), and
  [hardware capability guide](../vendor/vexo-open-kit/AGENTS.md).
- The official [Mentra Bluetooth camera documentation](https://docs.mentraglass.com/bluetooth-sdk/camera-streaming),
  checked on 2026-11-14. This camera path is for supported Mentra Live hardware.
- The teammate's `adjust`, `step`, `toggle`, `select`, `command`, and `say` contract.
- Remote `origin/main` commits `1379069` (`TARGET.md`) and `00d684b`
  (iPhone coordinator and Mac bridge integration), merged into this API branch.

## Band: native data versus adapter output

| Contract field or behavior | Actual source | Integration responsibility |
| --- | --- | --- |
| `toggle` | SDK event `kind: "tap"` after `configure(events=True)` | Band owner maps the event to `{"type":"toggle"}` |
| `select` | SDK event `kind: "double-tap"` | Band owner maps the event; hub target selection is separate |
| `adjust.delta` | SDK motion axes `ax`, `ay`, `az`, `gx`, `gy`, `gz` | Band owner's recognizer produces normalized increments; not a native SDK field |
| `step.direction` | The same raw motion axes | Band owner's recognizer classifies a flick; not the activity stream's lifetime step count |
| Forearm level, raised wrist, cooldown, exclusivity | Raw motion is available; these are not SDK guarantees | Band owner implements and tests the recognizer/state machine |
| `command.text` | SDK audio provides raw Opus packets, not text | A separately chosen STT pipeline produces one finalized transcript |
| `say.text` | Not a band hardware capability | A Mac, phone, or supported glasses audio adapter must perform playback |
| `device_id` | App configuration | Register the logical device, then supply it in the URL query |
| Event ID / receive time | BE-generated metadata | No fabricated SDK ID, confidence, or wall-clock timestamp is required |

Acceleration is in g; angular velocity is in degrees per second. `motion=50`
provides 50 Hz samples. Configure the streams after each hardware connection.
Native tap events have `kind`, `arg`, `t`, and `time`; native motion messages have
the axes and time fields. Do not send these raw messages to the normalized input
endpoint without the band owner's mapping/classifier.

Vexo has a microphone and an LED, but no speaker. `configure(audio=True)` produces
`opus` bytes; `mic_level` is loudness only. Raising/lowering the wrist is not a
native start/stop transcription API. STT is an additional implementation, which
may be local or a service; a remote STT service requires explicit microphone
consent and its own credentials. No live microphone is used by these tests.

While either `audio` or `mic_level` is enabled, Vexo locks the LED to its microphone
privacy indicator. Stop both streams before showing a normal gesture status LED.
Do not promise simultaneous arbitrary LED colors and active microphone capture.

The teammate's voice contract is feasible as an adapter/system interface, not as
a statement that the band itself supplies transcripts and plays speech. This
branch accepts the completed `command` payload but implements neither STT nor TTS.

The half-second guarantee must also distinguish a discrete gesture cooldown from
the small increments during a continuous twist. The API accepts each increment;
it does not invent or enforce recognizer timing rules.

## Glasses: capture on the client, upload to the BE

The glasses owner establishes the real SDK connection first. Backend registration
does not perform Bluetooth scanning. For photo delivery, set these documented
`requestPhoto` options in the already-connected client:

```json
{
  "size": "medium",
  "webhookUrl": "http://<reachable-mac-host>:8000/v1/glasses/photos?device_id=glasses-1",
  "authToken": "<demo-session-token>"
}
```

Use the actual reachable LAN address and matching exported BE session token.
Use HTTPS outside a trusted private demo network. Register `glasses-1` as
`device_type: "glasses"` before requesting capture. The Mac must listen on the LAN;
`127.0.0.1` on a phone or the glasses does not address the Mac.

| HTTP field / response | Source |
| --- | --- |
| Multipart file `photo` | The delivered JPEG bytes |
| Multipart `requestId` | SDK-generated capture ID, or the caller's documented optional `requestId` |
| Bearer authorization | SDK uploader's documented `authToken` option |
| Query `device_id` | Logical identity included by the app in `webhookUrl`, not a new SDK multipart field |
| Response `photoUrl` | BE-generated artifact URL; documented optional webhook response metadata |
| Response `width`, `height`, `content_type`, `size_bytes`, `artifact_id` | Derived/generated by the BE; not required from the SDK |

Do not send base64 JSON or require the SDK to invent a `device_id` form field.
The uploader sends `photo` plus `requestId`. A phone-side `fileUri` event is a local
file reference, not the JPEG bytes; use the webhook route or read and forward that
file in the client. Glasses use Wi-Fi for direct delivery or the SDK's phone-side
Bluetooth fallback relay.

`requestPhoto` terminal success means capture and delivery completed. Intermediate
`photo_status` values such as `accepted` are not upload success. Our **201**
`status: "received"` means saved image bytes, not successful vision recognition.
The SDK may read the optional `photoUrl`; the other snake_case fields are our
application metadata, not extra SDK photo-result properties. Artifact downloads
still require the session header when configured; a bare URL is not a public link.

## Relationship to the remote target specification

Commit `1379069` adds a fuller `LOOK -> GRAB -> LOOK -> THROW` profile:
iPhone coordinator, `gesture.detected` carrying `grab`/`throw`, QR target selection,
Mac WebSocket on port 8765, and an iPhone photo receiver on port 8787.

The current teammate vocabulary is a different input abstraction. `select` is not
implicitly `grab`, `step` is not implicitly `throw`, and `toggle` is not implicitly
window movement. A business mapping/state machine must be chosen explicitly if
the team adopts the remote profile. A photo alone also does not establish gaze or
the selected device; target recognition is a later consumer.

The current HTTP intake runs on the Mac on port 8000. It preserves the old
WebSocket code and label-based `/v1/gestures` endpoint, but does not bridge either
one to the new band input buffer. The branch includes the upstream target and
iPhone/Mac bridge integration through `00d684b`, without claiming that the new
HTTP inputs are wired into that flow. Demo 2 remains outside the API change.

## Verification and limits

Run `make check PYTHON=.venv/bin/python` after `make mac-setup`.

- Exact teammate event bodies are sent through the real FastAPI application.
  Tests cover bounds, strict direction values, missing fields, wrong device roles,
  authentication, retry IDs, and conflicts. Unknown `say` input is rejected.
- Upload safety tests verify pre-parse authentication, early rejection of oversized
  declared/chunked bodies, and controlled rejection of excessive image metadata.
- Real Vexo Python SDK plus its official `SimTransport` runs without BLE hardware.
  SDK-produced tap kinds are mapped in a test fixture to `toggle`/`select`, then
  posted to the API. Raw motion and Opus audio fixtures characterize the available
  source fields. This is not the teammate's production adapter or classifier.
- Mentra is tested with a documented HTTP wire-format fixture: a valid JPEG,
  multipart `photo` plus `requestId`, query device identity, and Bearer token.
  Saved bytes and authenticated retrieval are verified. This is not a running
  Mentra SDK, a glasses simulator, or proof of real capture or delivery.
- Existing label-based gesture, photo, wire-protocol, and simulated window tests
  remain part of the same test run.

No hardware-level claim follows from these tests. Real BLE reconnect behavior,
custom gesture accuracy, forearm/cooldown/speaking suppression, finalized STT,
speech playback, phone permissions, LAN delivery, target recognition, and real
macOS window movement still require their owners' implementation and live tests.
