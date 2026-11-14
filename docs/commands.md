# Voice Command API

The adapter sends one finalized raw transcript per utterance:

```json
{"type":"command","text":"set a ten minute timer"}
```

The BE saves the text unchanged in SQLite. It does not transcribe audio, interpret
intent, execute actions, or play speech. New records remain `received`; there is
no execution worker or public status-update endpoint in this slice.

## Register and submit

Register the sender with `POST /v1/devices/connect` using a logical `device_id`
and `device_type: "band"`. Registration does not establish Bluetooth connectivity.
The adapter must register again after API restart.

`POST /v1/commands?device_id=band-demo`

```bash
curl -X POST 'http://127.0.0.1:8000/v1/commands?device_id=band-demo' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: utterance-001' \
  -d '{"type":"command","text":"set a ten minute timer"}'
```

Response: **202**

```json
{
  "status": "accepted",
  "event_id": "utterance-001",
  "device_id": "band-demo",
  "received_at": "2026-11-14T21:00:00Z",
  "command_id": "32-character-generated-identifier"
}
```

`accepted` means the database write committed, not that an action ran. The BE
generates `command_id` and receive time; the SDK need not supply them.

The existing `POST /v1/band/events?device_id=band-demo` accepts the same `command`
body and returns the same response. Both routes share persistence and retry
protection. Other band inputs retain their existing transient response shape.

`text` must be nonblank and at most 4000 characters. Leading/trailing whitespace,
casing, and punctuation are preserved. Extra fields, raw audio, and outbound
`say` are rejected. Do not send interim transcription updates as commands.

## Query

`GET /v1/commands/{command_id}` returns **200**:

```json
{
  "command_id": "32-character-generated-identifier",
  "event_id": "utterance-001",
  "device_id": "band-demo",
  "text": "set a ten minute timer",
  "status": "received",
  "received_at": "2026-11-14T21:00:00Z"
}
```

`GET /v1/commands?device_id=band-demo&limit=50&offset=0` returns an array, newest
first. Device filtering is optional. `limit` defaults to 50 and accepts 1–100;
`offset` defaults to 0 and must be nonnegative. No matches returns `[]`. History
remains queryable without re-registering an old device. Offset pagination is not
a fixed snapshot while new commands arrive.

## Retry and error behavior

- Generate a new optional `Idempotency-Key` per utterance and preserve it on retry.
  Without a key, even identical text is a new command each time.
- The same device/key/text returns the original response across both intake
  routes, app restart, and eviction of the transient 1000-event band buffer.
- Changed text with the same device/key returns **409**. Keys are device-scoped;
  do not reuse them across gestures and commands. Other gesture retry protection
  remains limited to the live buffer and does not become durable.
- Invalid input returns **422**, unknown sender or command **404**, wrong device
  type **409**, and failed storage **503**. Failed writes are never accepted;
  retrying with the same key is safe after storage recovers.

## Storage and security

The default database is `.data/commands.sqlite3`, relative to the API working
directory. Override it with exported `BODYOS_COMMAND_DB` or `create_app`'s
`command_db` path. Parent directories and schema are created on first write.
Keep the path stable across restarts. SQLite uses Python's standard library.

Transcripts are plaintext local data, are not automatically expired, and are not
sent to an external model by this API. Keep `.data/` out of Git and apply suitable
local file access and retention controls. Tests use synthetic transcripts only.

All routes require the same Bearer header when `BODYOS_SESSION_TOKEN` is set.
Add it to the example when configured. This is a shared trusted-demo credential,
not per-user authorization. For other devices, use the Mac's reachable LAN address
and a configured token; `127.0.0.1` refers to that client's own host. Use HTTPS for
remote deployment. The API does not automatically load `.env` files.

## Voice and future actions

The SDK's Opus audio still requires the adapter's separately configured STT.
`{"type":"say","text":"Lamp"}` is an outbound hub-to-playback-adapter message,
not an input to these routes. No `say` queue, delivery channel, or TTS is provided;
Vexo has no speaker. Preserve microphone/camera privacy indicators.

A later dispatcher can interpret stored text, map it to allowlisted actions,
execute, and record results. Never run raw transcript text as a shell command.
Successful intake does not imply a timer, LLM, window action, or playback.

## Verification

`make check PYTHON=.venv/bin/python` includes real SQLite and HTTP tests covering
raw text, restart persistence, endpoint compatibility, concurrent retries across
app instances, validation, auth, pagination, storage errors, SQL-like text, and
slow-write/gesture key conflicts. These do not test real STT, TTS, or hardware.
