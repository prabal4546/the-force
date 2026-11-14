# Vexo band 76: motion check and simple dashboard

Two small things that talk to our Vexo band (`Vexo-HACK-76`) over Bluetooth:

- `band_check.py` prints one motion reading a second for 30 seconds, plus taps.
- `index.html` is a dashboard page: connect, battery, six live motion graphs, tap log.

## Setup

You need Python 3.9 or newer, and Chrome or Edge for the dashboard.

1. Clone `the-force`. The checked-in Vexo reference kit under
   `vendor/vexo-open-kit` is served automatically by the dashboard server.

2. Install the one Python dependency (only needed for `band_check.py`).

       python3 -m venv .venv
       source .venv/bin/activate
       python3 -m pip install bleak

3. Turn the band on and keep it close to the computer.

## Run the motion check

    python band_check.py          # the real band, over Bluetooth
    python band_check.py --sim    # a pretend band, no hardware needed

The first real run asks for Bluetooth permission for your terminal. Allow it and run again.

## Run the dashboard

The page cannot be opened by double-click: it has to be served.

    make band

Then open <http://localhost:8001/index.html> in Chrome or Edge, press **Connect** and pick
`Vexo-HACK-76` in the list. To try it without the band, open
<http://localhost:8001/index.html?sim> instead.

When the Mac runtime is running, the dashboard also connects to
`ws://127.0.0.1:8765`: a single tap sends **GRAB**, a double-tap sends **THROW**,
and a left/right wrist step sends the matching macOS presentation arrow. This
lets the band drive Keynote, PowerPoint, or Google Slides even when a particular
window cannot be moved. The original events are still recorded by the HTTP API.

`serve.py` is a plain file server that also keeps the band's motion, and what the gesture
detector made of it, in `traces/trace.jsonl` (motion only, on this computer, not in git), so a
gesture that misbehaves can be looked at afterwards. `python3 -m http.server` works too, without the trace.

## Remote: gestures (band module)

`band-module.js` turns wrist gestures into messages for the hub. It exports
`onEvent(callback)` for outgoing messages and `handle(message)` for incoming ones, and has
no transport of its own. The maths is in `gestures.js`; every threshold is in `CONFIG` at
the top of that file.

On the dashboard: double-tap the band, close any other tab that uses it, press **Connect**,
then **Calibrate** and follow the two steps (arm level, then twist starting clockwise). Each step is checked and can be retried on its own. The calibration is kept in the browser's localStorage.

| Gesture | Message |
|---|---|
| A quick turn of the wrist to the right (clockwise) | `{ "type": "step", "direction": 1 }` |
| A quick turn of the wrist to the left (counter-clockwise) | `{ "type": "step", "direction": -1 }` |
| Tap | `{ "type": "toggle" }` |
| Double-tap | `{ "type": "select" }` |

The arm makes one gesture: turn the wrist quickly, like turning a key. Every quick turn is
one step in its direction. A slow turn does not count: to step the same way twice, turn
quickly, come back slowly, turn quickly again. `adjust` is no longer sent.

How it works (`gestures.js`, `gestures: 'turn'`):

- Only the wrist's turning about the forearm is looked at, from the gyro. A turn starts when
  it passes `turnStartDps` and ends when it stops or turns back.
- It is a step once it has gone `turnOutDegrees` (45, the easy way) or `turnInDegrees` (40),
  peaked above `turnMinDps` (250 deg/s), and the arm itself turned at most `turnArmShare`
  (half) of what the wrist turned. So raising, lowering or swinging the arm sends nothing.
- One turn is one step, however far it goes, and a turn of more than half a circle keeps
  its direction.
- Nothing counts while the forearm is more than 50 degrees from level (`clutchDegrees`).
- Calibration is two poses: arm level, then twist (it gives the forearm's direction in the band).

The numbers come from a recording of the real band, kept as
`test/fixtures/real-wrist-turns.json` and replayed in the tests: eight deliberate turns of 70
to 200 degrees at 360 to 1000 deg/s all count, in their direction, and two arm raises and
four arm swings in the same recording count as nothing.

An older wrist mode, `gestures: 'tilt'`, reads the wrist's angle from gravity instead: tip
past a line and come back, where coming back never counts. On the real band that dropped
every turn back the other way, and a turn of more than half a circle came out reversed.
What follows describes it:

- The centre is wherever the level arm holds still (`settleMs`): thumb up, palm down or
  between. It is the average over that moment, and it keeps following a wrist that rests
  near it. Tipped far enough from the centre for `tiltHoldMs` is one step.
- How far depends on the arm (`wearingArm`, and the Left arm / Right arm buttons on the
  page). A forearm turns outward (thumb away from the body) more easily than inward, and
  outward is left on the left arm, right on the right arm. Outward asks `tiltOutDegrees`
  (30), inward `tiltInDegrees` (24).
- Optional, off by default (`tiltRangeShare`): ask less of a wrist that already rests turned
  one way, as a share of the room it has left (about 85 degrees outward and 75 inward of
  thumb up). It only fits if the level pose in calibration was thumb up.
- Only a turn of the wrist counts. If the arm itself turns (`tiltArmDps`, about anything
  but the forearm, for `tiltArmMs`, allowing for `tiltArmLeak` of the wrist's own turning) or the forearm is raised or lowered (`tiltArmDegrees`), the centre is
  forgotten and found again once the arm is still. So moving around sends nothing.
- The wrist has to come back within `tiltReturnDegrees` (12) of the centre before the next
  step. Coming back never sends anything, so there is no step in the opposite direction.
- A wrist that rests somewhere new for `tiltRecentreMs` makes that the centre.
- Nothing counts while the forearm is more than 50 degrees from level (`clutchDegrees`).
- Calibration is two poses: arm level, then twist (it gives the forearm's direction in the band).

Two older modes read turning speed instead and were not reliable enough on the real band.
They are still in the code: `gestures: 'leftRight'` (a sideways sweep or a wrist turn, one
step each) and `gestures: 'twistAndSwipe'` (a twist sends `adjust`, a swipe sends `step`).
Both need the third calibration pose, the swipe.

**Fine tuning** on the page has a slider for each threshold that matters. A slider takes
effect at once and is kept in that browser's localStorage. **Copy for CONFIG** gives the
changed values as text to paste into `CONFIG`, which is how they reach everyone else.

Calibrations saved before the swipe change are dropped: the page asks to calibrate again.

### Voice

The band's microphone turns on at connect (solid blue light) and its sound goes to
Deepgram the whole time (`speech.js`, copied from the kit, with `keyterm=Vexo`). Gestures
keep working meanwhile.

- Say **"Vexo"** and then what you want. When Deepgram marks the sentence finished, one
  `{ "type": "command", "text": "..." }` is sent. Nothing within 3 seconds sends nothing.
  The spellings that count as the wake word are `wakeWords` in `CONFIG` (`wake.js` has the logic).
- Or hold the **spacebar** and speak: everything said while it is held is one command.
- **Mute** turns the microphone off.
- The microphone gain starts at `micGainDb` (+8 dB) so only a voice near the wrist
  registers. The page shows the live loudness and has a gain field for tuning.

While the microphone is on, the band's light is locked blue and no LED command is sent:
the active device, gesture flashes and errors show on the page instead.

Paste the team's Deepgram key into the key field on the page. It is kept in that tab's
sessionStorage only: never put it in a file or a commit. Everything the microphone hears,
from everyone nearby, goes to Deepgram: tell the people near you and mute when not in use.

### Device API (the-force)

Every outgoing message is posted to the team's device API, as its contract asks
(`the-force`, branch `codex/api`, `docs/api.md`; the body schema is kept in
`contract/band-input.schema.json`):

- On connect the band is registered: `POST /v1/devices/connect` with
  `{ "device_id": "vexo-28", "device_type": "band", "hardware_status": "connected" }`, and
  `"disconnected"` when the band drops. The ID is `vexo-` plus the band number.
- Each message goes to `POST /v1/band/events?device_id=vexo-28`, body unchanged, with a new
  `Idempotency-Key` per event. A retry of the same event reuses its key.
- `hub.js` checks each message against the contract first (the API is strict: no extra
  fields, `direction` is the integer -1 or 1, command text not blank and at most 4000
  characters) and does not send one that would be refused.
- If the API restarted and forgot the band (404), the band is registered again and the event
  sent again. An event that cannot be delivered within 3 seconds is dropped, not sent late.
- The page shows the state next to **Outgoing messages**: connected, not reachable or
  refused, with the reason.

The page reaches the API through `serve.py` (`/hub/...`), because a browser page cannot call
another address that sends no CORS headers, and so the session token stays out of the browser:

    export BODYOS_API_URL=http://127.0.0.1:8000     # where the API runs (this is the default)
    export BODYOS_SESSION_TOKEN=your-team-demo-token   # only if the API was started with one
    python3 serve.py

The API has no channel back to the band yet, so `active`, `say` and `error` below still come
only from the test buttons on the page. The contract has `step` (-1 left, 1 right, one per
gesture), `toggle`, `select` and `command`. `adjust` was taken out of it: only the old
`twistAndSwipe` mode makes one, and `hub.js` does not send it on.

### Incoming messages

| Message | What happens |
|---|---|
| `{ "type": "active", "device": "lamp", "color": "#ffaa00" }` | The device shows on the page. With the microphone muted the band's light also takes the colour |
| `{ "type": "say", "text": "Lamp" }` | Spoken through this computer's speaker with ElevenLabs (`tts.js`). Each text is fetched once, then played from memory |
| `{ "type": "error" }` | The page flashes red with a low beep. Muted, the band's light also blinks red three times and returns to its colour |

The ElevenLabs key goes into its own field on the page and is handled like the Deepgram key.
The voice and model are `ttsVoiceId` and `ttsModel` in `CONFIG`. The page has test buttons
that send each of the three messages.

Tests (Node 18 or newer, no band needed):

    npm test

## Using a different band

Change `BAND = 76` near the top of both `band_check.py` and `index.html`. The band module
takes the connected band from the page and has no number of its own.
