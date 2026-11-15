# Agent Guide

## Language and scope

Keep source code, identifiers, comments, documentation, and API examples in English.
Discussion with the user may use Chinese or English.

The Python HTTP API implements local device registration and input reception.
Do not describe accepted input as an executed action or registered hardware as a
verified Bluetooth connection. The band dashboard separately maps single tap to
GRAB and double-tap to THROW over the existing WebSocket coordinator path.

## Read first

- `docs/api.md`: request/response contracts, errors, retries, and LAN setup.
- `docs/sdk-compatibility.md`: SDK fields, adapter responsibilities, and test limits.
- `shared/protocol/band-input.schema.json`: normalized band input body.
- The running `/openapi.json` and `/docs`: complete HTTP schemas.

`shared/protocol/events.schema.json` describes a different WebSocket envelope.
Do not send the HTTP band-event body directly to it. The explicit demo mapping
is implemented in `apps/band/coordinator-link.js`: `toggle` becomes GRAB and
`select` becomes THROW; `step` becomes a left/right macOS presentation key.

## Start and verify

From the repository root:

```bash
make mac-setup
make check PYTHON=.venv/bin/python
make api PYTHON=.venv/bin/python
```

The default API address is `http://127.0.0.1:8000`. For another device, explicitly
export `BODYOS_API_HOST=0.0.0.0` and `BODYOS_SESSION_TOKEN`, use a private LAN, and
address the Mac by its reachable hostname or IP. API startup reads only
`GEMINI_API_KEY` and `GEMINI_MODEL` from `services/mac-runtime/.env`; other
settings must be exported. Never commit tokens, photos, or local credentials.

## Client integration

1. The device owner connects hardware with its supported SDK.
2. Register the logical adapter with `POST /v1/devices/connect`. `hardware_status`
   is a client report. A `registered` response does not establish a BLE session.
3. Band: `POST /v1/band/events?device_id=<registered-id>` accepts the teammate's
   `step`, `toggle`, `select`, and finalized `command` bodies. Gesture `step`
   means -1 for a left swipe or 1 for a right swipe, one event per swipe.
   The removed `adjust` event is rejected.
   A **202** `accepted` response means buffered input only.
4. Glasses: set the connected Mentra client's `requestPhoto` webhook URL to
   `/v1/glasses/photos?device_id=<registered-id>`. The uploader sends multipart
   `photo` and `requestId`; `authToken` supplies the Bearer header. A **201**
   `received` response means validated/saved bytes, not target recognition.
5. Fetch returned `photoUrl` with the same Bearer header when configured. Artifact
   URLs and in-memory indexes are not durable across server restarts.

Generate a new optional `Idempotency-Key` per distinct band event; reuse it only
for that event's retry. Consecutive swipes are distinct events even when they
share a direction. Register devices again after server restart. Use one API worker.

## Hardware boundaries

- Vexo supports direct Mac BLE or USB. The band owner owns the real connection,
  stream configuration, reconnection, gesture recognition, and forwarding.
- `tap` and `double-tap` are native Vexo events. `step` requires an IMU
  recognizer. Native audio is Opus, not text. The band has no speaker.
- `command` requires separately implemented STT. `say` is outbound playback, not
  an accepted input; this API does not implement TTS or command delivery.
- The documented Mentra Live path uses a phone SDK for BLE control, plus Wi-Fi
  photo upload or a phone-side BLE fallback relay. Do not invent a supported
  direct-Mac, all-BLE image path without verifying its actual SDK implementation.
- Preserve camera/microphone privacy indicators. Do not capture live media or
  transmit it externally to run mock tests.

## Change discipline

Work on the feature branch requested by the user. Fetch before pushing, preserve
other owners' changes, and never force-push or merge into `main` without an
explicit request.

Keep hardware SDK dependencies out of the intake implementation; SDK imports in
contract tests are fixtures only. Update contracts and consumers together.
Run `make check` after changes and before pushing.

Vexo tests exercise the official `SimTransport`; Mentra tests use a documented
HTTP upload fixture and a generated JPEG, not running glasses or a Mentra SDK.
Report those limits. Never claim hardware readiness, classifier accuracy, speech
playback, target selection, or real window movement from intake tests alone.
