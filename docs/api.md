# Device input API

This first API slice has three inputs: device registration, a recognized gesture,
and a photo from glasses. It runs in the existing Python Mac runtime package.
The older WebSocket/iPhone-coordinator demo remains separate. This API does not
connect physical Bluetooth devices, trigger glasses capture, recognize images,
or move windows yet.

## Start

From the repository root:

```bash
make mac-setup
make api PYTHON=.venv/bin/python
```

The API defaults to `http://127.0.0.1:8000`. Interactive schemas and inputs are at
`/docs`; the machine-readable contract is `/openapi.json`.

For clients on a phone or a teammate's computer, bind to the LAN deliberately:

```bash
export BODYOS_API_HOST=0.0.0.0
export BODYOS_SESSION_TOKEN='your-team-demo-token'
make api PYTHON=.venv/bin/python
```

Clients use the Mac's reachable LAN address, not `localhost`. All `/v1` routes
require `Authorization: Bearer <BODYOS_SESSION_TOKEN>` when that environment
variable is set. Set the token in Swagger's **Authorize** dialog when testing.
Use Mentra's `authToken` option for its uploader. These are trusted demo clients
sharing a session credential, not a production user/device authentication system.
Use a private LAN for HTTP; remote deployment needs HTTPS.

Configuration is read from exported environment variables. A `.env` file is not
loaded automatically. `BODYOS_API_PORT` changes the default port;
`BODYOS_UPLOAD_DIR` changes the photo directory, default `.data/photos`.

## 1. Register a device adapter

`POST /v1/devices/connect` with JSON:

```json
{
  "device_id": "vexo-76",
  "device_type": "band",
  "hardware_status": "connected"
}
```

`device_type` is `band`, `glasses`, `iphone`, or `mac`. `hardware_status` is optional:
`connected`, `disconnected`, or `unknown` (default). IDs contain letters, numbers,
underscores, and hyphens, up to 128 characters.

Response: **200**

```json
{
  "device_id": "vexo-76",
  "device_type": "band",
  "hardware_status": "connected",
  "status": "registered",
  "registered_at": "2026-11-14T21:00:00Z",
  "last_seen_at": "2026-11-14T21:00:00Z"
}
```

The adapter owner first connects real hardware with their SDK, then reports it.
`registered` confirms BE registration; it does not prove a BLE connection or open a
persistent HTTP/WebSocket session. `hardware_status` is the client's report, not a
server probe. Register again with the same ID/type to update that report; changing
the type for an existing ID is a **409** conflict.

`GET /v1/devices/{device_id}` returns the same status shape. Successful gestures and
uploads update `last_seen_at`. There is no heartbeat or automatic offline detection
in this slice, so an old hardware report must not be treated as live readiness.

## 2. Send a band event (current teammate contract)

Register the sender as a `band` first, then use:

`POST /v1/band/events?device_id=vexo-76`

The JSON body is the teammate's original payload, unchanged:

| Event | JSON body | Validation |
| --- | --- | --- |
| Swipe left / right | `{"type":"step","direction":1}` | JSON integer -1 for left or 1 for right; one event per swipe |
| Single tap | `{"type":"toggle"}` | No additional fields |
| Double tap | `{"type":"select"}` | No additional fields |
| Completed transcript | `{"type":"command","text":"set a ten minute timer"}` | Nonblank raw text, at most 4000 characters |

The updated gesture contract contains only `step`, `toggle`, and `select`.
The former `adjust` event is no longer accepted and returns **422**.
`direction` describes physical swipe direction, not an implicit previous/next or
window movement command. The hub owns that business mapping. Voice input remains
unchanged.

The `device_id` query is adapter configuration, not an invented SDK event field.
No client timestamp, confidence, or event ID is required. The server generates an
event ID and receive time. The shared body contract is
[`../shared/protocol/band-input.schema.json`](../shared/protocol/band-input.schema.json).
The running API's `/openapi.json` also defines all request and response models.

```bash
curl -X POST 'http://127.0.0.1:8000/v1/band/events?device_id=vexo-76' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: event-001' \
  -d '{"type":"step","direction":1}'
```

Response: **202**

```json
{
  "status": "accepted",
  "event_id": "event-001",
  "device_id": "vexo-76",
  "received_at": "2026-11-14T21:00:01.123Z"
}
```

`accepted` means buffered, not executed: no timer starts, target is selected,
speech plays, or window moves. The newest 1000 band events are retained in memory.
This endpoint does not yet publish events to the older WebSocket coordinator.

`Idempotency-Key` is optional transport metadata. It accepts 1–128 letters,
numbers, underscores, or hyphens. Within the retained buffer, reuse the same key
for retries of the same event: matching payload returns the original response;
changed payload returns **409**. Keys are scoped per device. Without a key, every
request is a new event. Send one `step` message per swipe and generate a new key
for each distinct swipe, even when consecutive swipes have the same direction.
Reuse the key only when retrying delivery of that same event. No recognizer
cooldown or posture guarantee is enforced by this intake endpoint.

`say` is an outbound playback instruction, not a band input, and returns **422**
here. Playback and a command-delivery channel are not implemented in this slice.
See [`sdk-compatibility.md`](sdk-compatibility.md) for SDK field provenance, voice
hardware limits, and what the tests actually verify.

### Earlier label-based gesture input (retained)

`POST /v1/gestures` with JSON:

```json
{
  "event_id": "gesture-001",
  "device_id": "vexo-76",
  "gesture": "double-tap",
  "timestamp": "2026-11-14T21:00:01Z"
}
```

Register the sender as a `band` first. `gesture` is a lowercase adapter-defined
label, such as `double-tap`, `grab`, or `throw`; underscores and hyphens are accepted.
The BE does not assign business meaning to these labels yet. `timestamp` is
optional; when provided, it must include a timezone. An optional `confidence`
number from 0 to 1 is accepted. Omit it for template distance scores that have not
been calibrated as confidence.

Response: **202**

```json
{
  "status": "accepted",
  "event_id": "gesture-001",
  "device_id": "vexo-76",
  "received_at": "2026-11-14T21:00:01.123Z"
}
```

`accepted` means received into the in-memory event buffer, not that a window moved.
The newest 1000 distinct legacy events are retained separately. Within that buffer, retrying the same
device/event ID with the same payload returns the original response without a new
event. A conflicting payload returns **409**. Reuse the original event ID and
timestamp on retry; create a new ID for a genuinely new gesture.

## 3. Send a glasses photo

Register a device such as `glasses-1` with `device_type: glasses` first.

`POST /v1/glasses/photos?device_id=glasses-1`

Content type: `multipart/form-data`.

| Input | Location | Meaning |
| --- | --- | --- |
| `device_id` | URL query | Registered logical glasses device |
| `requestId` | Form field | Capture/request ID, 1–128 characters |
| `photo` | File field | A real JPEG or PNG image |

The query parameter deliberately keeps the multipart body compatible with Mentra's
documented `photo` + `requestId` uploader. The glasses adapter can set its webhook URL
to this address. The same endpoint accepts a teammate's ordinary HTTP upload.

```bash
curl -X POST 'http://127.0.0.1:8000/v1/glasses/photos?device_id=glasses-1' \
  -F 'requestId=capture-001' \
  -F 'photo=@photo.jpg'
```

Add an `Authorization` header to client examples when the demo token is configured.
Use the LAN hostname/address rather than loopback in the glasses webhook URL.

Response: **201**

```json
{
  "status": "received",
  "request_id": "capture-001",
  "device_id": "glasses-1",
  "artifact_id": "generated-artifact-id",
  "content_type": "image/jpeg",
  "width": 1280,
  "height": 720,
  "size_bytes": 123456,
  "photoUrl": "http://127.0.0.1:8000/v1/artifacts/generated-artifact-id"
}
```

`received` means the image was validated and saved locally; it does not mean a
vision model has recognized a target. `photoUrl` is also compatible with Mentra's
optional webhook-returned photo metadata. `GET /v1/artifacts/{artifact_id}` returns
the original bytes; include the session header when configured.

Images are limited to 10 MiB and 40 megapixels. Client filenames are ignored; files
use generated IDs. Invalid images return **415**, oversized images return **413**,
and partial files are removed. Repeating a device/request ID with identical bytes
returns the original artifact; different bytes for the same request return **409**.
Dimensions describe the uploaded image, before any future orientation/vision work.
Configured session authentication runs before request-body parsing. Photo request
bodies are capped before multipart parsing at the image byte limit plus 64 KiB of
multipart overhead; the separate image-file byte limit is still enforced. Rejected
oversized streams are not fully consumed or spooled by the multipart parser.

## Errors and lifecycle

Errors use the FastAPI shape `{"detail": ...}`. Invalid JSON fields return **422**,
missing/invalid configured credentials **401**, unknown devices/artifacts **404**,
and wrong device roles or conflicting IDs **409**. A wrong role is checked before
saving a photo or accepting a gesture.

`GET /healthz` returns `{"status": "ok"}` without requiring hardware or credentials.

Run one API process/worker. Registration, deduplication indexes, and artifact lookup
metadata are in memory and reset on restart; clients must register again. Photo
files remain on disk but old artifact URLs are not restored automatically. This
is an intake API for integration, not durable event processing or a production
storage service. The BE never scans for another team's band or silently turns
registration into a hardware connection attempt.
