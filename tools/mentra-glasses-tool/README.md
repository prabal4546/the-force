# mentra-glasses-tool

**Gets screenshots from Mentra Live glasses into the team's device API (branch `codex/api`), as many
per second as the glasses can give.** Each screenshot goes to `POST /v1/glasses/photos` the moment it
exists, and a copy stays in `data/` on this Mac (git-ignored). Nothing else: no video is kept or sent.

    glasses --live stream (Wi-Fi)--> this Mac: npm run frames --> a JPEG per frame --> codex/api API
                                                                \--> data/<time>_stream/photos/

## Fast screenshots: `npm run frames`

A photo command costs the glasses seconds over Bluetooth. Their live stream carries 15-30 frames a
second, so `npm run frames` listens for that stream and turns **every frame into a screenshot**.

1. Start the API on a Mac (in a checkout of `codex/api`, see `docs/api.md` there):
   ```bash
   make mac-setup
   ```
   ```bash
   BODYOS_API_HOST=0.0.0.0 BODYOS_SESSION_TOKEN=<team token> make api PYTHON=.venv/bin/python
   ```
2. Here (needs Node 20.12+ and `ffmpeg`: `brew install ffmpeg`; no `npm install` needed for this):
   ```bash
   BODYOS_API_URL=http://<API Mac's address>:8000 BODYOS_SESSION_TOKEN=<team token> npm run frames
   ```
   Or put the two settings in `.env` (copy `.env.example`) and run `npm run frames`.
3. Start the glasses' stream to the printed address (`rtmp://<this Mac>:1935/live/glasses`):
   in **Mentra's example app**, **Stream** screen, paste it and start. Glasses and Mac on the same Wi-Fi.
   (Or the SDK route below with `STREAM=1`.)

Each second it prints how many screenshots were cut, how many the API kept, and how many are still
waiting. When the stream stops it sends the last ones and exits; Ctrl+C stops it at any time.

- `FRAMES_PER_SEC=0` (default): every frame. `FRAMES_PER_SEC=5`: 5 a second.
- `FRAME_QUALITY` 2-31 (default 4): smaller number, better and bigger JPEG.
- `BODYOS_PARALLEL` (default 4): uploads at once. If the API is slower than the stream, nothing is
  dropped: screenshots wait on disk and the waiting count grows.
- `data/<time>_stream/` holds `photos/`, `events.jsonl` (each screenshot and its API artifact) and
  `latest.jpg` (the newest screenshot, replaced twice a second; the viewer shows it).
- At 720p a screenshot is about 50 kB: 1.5 MB a second at 30 a second, on this Mac and again on the API's.

### How fast

Measured here with a generated stream (RTMP from ffmpeg, not real glasses) and the real `codex/api`
API on the same Mac:

| Stream | Screenshots kept in the API | First screenshot after the stream starts | Upload time per screenshot |
|---|---|---|---|
| 720p, 30 fps, 20 s | 600 of 600 (30 a second) | 0.06 s | 5 ms typical, 6 ms for the slowest 5% |
| 1080p, 30 fps, 15 s | 450 of 450 (30 a second) | 0.09 s | 3 ms typical, 5 ms for the slowest 5% |

ffmpeg normally studies 5 seconds of a new stream before decoding; the tool lets it study half a
second, which brought the first screenshot from 4.6 s down to under 0.1 s without losing frames.
Over Wi-Fi to another Mac it will be slower: watch the waiting count.

## What the API gets

The API is the Mac runtime's device input API on branch `codex/api` (`docs/api.md` there). The tool:

1. registers the glasses: `POST /v1/devices/connect` with `device_id` `glasses-1` (`BODYOS_DEVICE_ID`),
   `device_type` `glasses`;
2. sends each screenshot: `POST /v1/glasses/photos?device_id=glasses-1`, multipart `photo` (JPEG) and
   `requestId`;
3. writes the answer to `events.jsonl` as `bodyos_stored` with `artifactId` and `url`
   (`GET /v1/artifacts/<id>` gives back the same bytes).

- The copy in `data/` is written first, so if the API is down nothing is lost. Each upload is tried 3
  times (and the glasses are registered again if the API restarted), then logged as `bodyos_failed`.
  A wrong token or a rejected file is not retried.
- Each screenshot has its own `requestId` (built from its file name, which includes the time it was
  saved), so a retry gives back the same artifact instead of a duplicate, and two runs never collide.
- The API takes JPEG and PNG up to 10 MB. WebP photos (the Wi-Fi receiver accepts them) stay in
  `data/` only (`bodyos_skipped`).
- The API keeps its artifact list in memory: after it restarts, old URLs stop working although its
  files stay on its disk.

Send screenshots that are already on disk:

```bash
npm run send -- data/<time>_stream/photos/*.jpg
```

## Slower ways to get screenshots

Each of these also sends every photo to the API when `BODYOS_API_URL` is set.

| Command | What | Speed |
|---|---|---|
| `npm run receive` | Wi-Fi receiver on port 8787. In Mentra's example app: **Camera** screen, **Use cloud server**, paste the printed *Media upload URL* (`/upload`, or `/mentra/photo` as in TARGET.md), take photos. Video clips are refused. | One photo per press, seconds each |
| `npm start` | SDK route through the MentraOS app and ngrok (setup below): one photo every `PHOTO_INTERVAL_SEC` (default 10) and on each button press. With `STREAM=1` it instead asks the glasses to stream to `npm run frames` (run it too). | Seconds per photo, or fast with `STREAM=1` |
| `npm run demo` | Pretend glasses: a picture every few seconds, no glasses, account or internet. For checking the pipeline. | Every few seconds |

Notes on the receiver: port 8787 is the same one Mentra's own receiver uses (run one, or set
`RECEIVER_PORT`). While it runs, anyone on the Wi-Fi can send it photos (JPEG, PNG or WebP, up to
25 MB): set `UPLOAD_TOKEN` if the app sends one, and stop it with Ctrl+C when you are done. macOS may
ask whether Node may accept incoming connections: allow it, or the glasses cannot reach it.

### SDK route setup (`npm start`)

Needs an [ngrok](https://ngrok.com) account with a static domain and the MentraOS phone app with the
glasses paired.

1. `npm install` (only this route needs it).
2. At [console.mentra.glass](https://console.mentra.glass) create an app: a unique package name such as
   `com.yourname.glassesrecorder`, Public URL = your ngrok static URL, and the **camera** permission.
   Copy the app's API key.
3. `cp .env.example .env`, fill in `PACKAGE_NAME` and `MENTRAOS_API_KEY` (only in `.env`, never commit it).
4. `ngrok http --url=<your-static-domain> 3000`
5. `npm start`, then open the app on the glasses from the MentraOS phone app.

For fast screenshots on this route: `STREAM=1` in `.env`, run `npm run frames` in a second terminal,
then `npm start`. The glasses stream to `RTMP_URL` (default: this Mac's address, port 1935) at
`STREAM_WIDTH` x `STREAM_HEIGHT`, `STREAM_FPS` (default 1280x720 at 30; if the glasses cannot do 30,
set 15). Photo commands are off while they stream (one camera, one job).

## See it

`viewer/` is a desktop app: `cd viewer`, `npm install`, `npm start` (see `viewer/README.md`). Tick
**fast screenshots**, press **Receive from glasses**, and paste the stream address it shows into
Mentra's Stream screen: the newest screenshot appears twice a second, and every session's screenshots
are in a grid.

## What is tested and what is not

| Part | Status |
|---|---|
| Cutting screenshots from a live RTMP stream and sending them; the API client (retries, re-registering, parallel uploads); the Wi-Fi receiver; settings; the viewer's folder reader and process starter | Tested here: `npm test` (49 tests) and the viewer's `npm test` (13). Both run in the repo's `make check` |
| Against the real `codex/api` API | Tested here: every screenshot kept, and the API's copies match the files in `data/` byte for byte |
| **Real glasses** (their stream, Wi-Fi, the SDK route) | **Not tested.** No glasses were available. The SDK calls were checked against `@mentra/sdk` 2.1.29's type files. Expect small fixes on first contact |

## Other things it records

`events.jsonl` in each run folder also has what the glasses report on the SDK route: head up/down,
button, touch, battery, stream status. Every record has `time` in milliseconds (this Mac's clock).

The glasses' SDK gives **no raw accelerometer or gyroscope** (only head up/down). `POST /imu` on the
SDK server (header `X-Ingest-Token: <INGEST_TOKEN>`, body `{ax,ay,az,gx,gy,gz[,t]}` or a list of up to
500) takes samples from another source, such as the Vexo band, into `imu.jsonl`. It is off while
`INGEST_TOKEN` is empty.

## Privacy

The camera light is on while the glasses take pictures or stream. Tell people near you, and stop when
they ask. Screenshots can contain faces and screens: keep `data/` off shared drives and out of git.

## Files

- `src/frames.mjs`: fast screenshots from the live stream (`npm run frames`)
- `src/bodyos.mjs`: sends screenshots to the device API; `npm run send -- <files>`
- `src/receiver.mjs`: photos straight from the glasses over Wi-Fi (`npm run receive`)
- `src/server.mjs`, `src/session.mjs`, `src/recording.mjs`: the SDK route (`npm start`) and the `/imu` door
- `src/demo.mjs`: pretend glasses (`npm run demo`)
- `src/live.mjs`: the live feed for the viewer (127.0.0.1 only)
- `src/store.mjs`: writes the files and keeps names safe
- `src/config.mjs`: reads and checks `.env`
- `test/`: `npm test`
- `viewer/`: the desktop app
