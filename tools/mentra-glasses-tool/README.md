# mentra-glasses-tool

Records what Mentra Live glasses can send to your Mac: **screenshots, video, and events**
(head up/down, button, touch, battery). It has a door for **accelerometer and gyroscope** samples,
but see "The IMU gap" first: the glasses' SDK does not give you those today.

Nothing here is committed or pushed anywhere. Recordings go to `data/` (git-ignored).

## Quickest way: photos and videos straight from the glasses (no cloud)

Mentra Live sends photos and video clips over **your Wi-Fi** to an address you give it; Bluetooth only
carries the commands. `npm run receive` is that address, on this computer:

1. Connect the glasses in **Mentra's example app** (Mentra's TestFlight build, on an Apple silicon Mac or an
   iPhone; see Mentra's "Update Mentra Live" page). Put the glasses on the **same Wi-Fi** as this computer.
2. Here: `npm run receive` (or **Receive from glasses** in the viewer app). It prints a *Media upload URL*
   such as `http://192.168.1.20:8787/upload` (`/mentra/photo`, the path in TARGET.md, works too).
3. In Mentra's app: **Camera** screen, turn on **Use cloud server**, paste that URL into **Media upload URL**,
   then take photos or record video. Each photo lands in `data/<time>_mentra-app/photos/`, each clip in
   `data/video/<time>_<id>/recording.mp4`, and both show up at once in the viewer.
4. Live video: also run `npm run video`, and paste the printed RTMP address into Mentra's **Stream** screen.

Tested here by sending a real JPEG and a real MP4 the way the glasses do (multipart `photo` / `video` plus
`requestId`, the format of Mentra's own receiver). **Not yet tried with real glasses.** Notes:
- Port 8787 is the same one Mentra's own receiver uses; run only one of them (or set `RECEIVER_PORT`).
- While it runs, anyone on the same Wi-Fi can send it files (only JPEG/PNG/WebP photos and MP4 videos are
  kept, up to 300 MB). Set `UPLOAD_TOKEN` to require a token if the app you use sends one, and stop it with
  Ctrl+C when you are done.
- macOS may ask whether Node may accept incoming connections: allow it, or the glasses cannot reach it.

## As many pictures per second as possible: `npm run frames`

A photo command costs the glasses seconds over Bluetooth, so commanded photos top out well below one
per second. The glasses' **live video** carries 15-30 frames per second, so this cuts every frame into
a JPEG and sends each to the BodyOS API as it is cut:

```bash
BODYOS_API_URL=http://<Mac running the API>:8000 BODYOS_SESSION_TOKEN=<API token> npm run frames
```

Then paste the printed RTMP address into Mentra's **Stream** screen (or, on the SDK route, set
`VIDEO=1` and `RTMP_URL` to it). Each second it prints how many pictures were cut, how many the API
kept, and how many are still waiting. Ctrl+C stops it: the last pictures are sent, then the
recording. In the viewer: tick **with live video** and **every frame as a picture**, then
**Receive from glasses**.

- Pictures in `data/<time>_stream/photos/` with `events.jsonl` (each picture and its API artifact).
  The recording and `latest.jpg` (newest picture, twice a second) in `data/video/<time>_stream/`,
  where `npm run video` keeps its recordings, so the viewer lists and plays it like any other.
  The recording is sent to the API when the stream stops.
- `FRAMES_PER_SEC=0` (default) keeps every frame; `FRAMES_PER_SEC=5` keeps 5 per second.
  `FRAME_QUALITY` 2-31 (default 4) trades picture size for quality.
- `BODYOS_PARALLEL` (default 4) uploads that many pictures at once. If the API is slower than the
  stream, nothing is dropped: pictures wait on disk and the waiting count grows.
- Every frame adds up: at 720p about 50 kB each, so 1.5 MB per second, 5 GB per hour, on this Mac and
  again on the API's Mac.
- It records one stream. If the glasses stop streaming (or Wi-Fi drops), it finishes and exits: start
  it again.
- Uses the same port (1935) as `npm run video`: run one of them.

Measured here with a generated stream (RTMP from ffmpeg, not real glasses) and the real API on the same
Mac: 720p at 30 fps gave 300 pictures in 10 seconds, all 300 kept, never more than one waiting;
1080p at 30 fps (about 83 kB each) also kept up at 30 per second. Over Wi-Fi to another Mac it will be
slower: watch the waiting count.

## Where the output is kept

Everything is kept in two places:

| What | `data/` on this computer (always) | Team BodyOS API (when `BODYOS_API_URL` is set) |
|---|---|---|
| Photos from the Wi-Fi receiver | `data/<time>_mentra-app/photos/` | Yes, as they arrive |
| Screenshots from the SDK route and the demo | `data/<time>_<user>/photos/` | Yes, as they arrive |
| Video clips from the Wi-Fi receiver | `data/video/<time>_<id>/recording.mp4` | Yes, as they arrive |
| Live-stream recordings (`npm run video`) | `data/video/<time>/recording.mp4` | Yes, when you stop it (Ctrl+C) |
| Pictures cut from the live stream (`npm run frames`) | `data/<time>_stream/photos/` | Yes, every one as it is cut |
| Its recording | `data/video/<time>_stream/recording.mp4` | Yes, when it stops |
| Frames from `npm run video` (one per second) | `data/video/<time>/frames/`, `latest.jpg` | No (use `npm run frames`) |
| Events (head, button, battery, what was kept where) | `events.jsonl` in each folder | No |

The API is the Mac runtime's device input API (`make api`, see `docs/api.md` on the API branch).
The tool registers the glasses as `device_type: glasses`, then sends photos to
`POST /v1/glasses/photos` and videos to `POST /v1/glasses/videos`
(`?device_id=<BODYOS_DEVICE_ID>`, default `glasses-1`, the id `docs/api.md` uses; multipart file plus
`requestId`). For each one, `events.jsonl` gets
a `bodyos_stored` line with `kind`, `artifactId` and `url`; `GET /v1/artifacts/<id>` returns the
original bytes. **The video endpoint is on branch `mentra-api-video`** (from `codex/api`) until it is
merged; against an API without it, clips are logged as `bodyos_failed` and stay in `data/`.

```bash
BODYOS_API_URL=http://<Mac running the API>:8000 BODYOS_SESSION_TOKEN=<API token> npm run receive
npm run send -- data/video/<time>/recording.mp4      # send any photo or video already on disk
```

- The copy in `data/` is written first, so if the API is down nothing is lost. Each upload is tried 3
  times (and re-registers the glasses if the API restarted), then logged as `bodyos_failed` and shown
  in the viewer. A wrong token or a rejected file is not retried.
- The `requestId` sent is the glasses' own id plus the file name, so each file gets its own artifact
  and a retry gives back the same artifact instead of a duplicate.
- The API takes JPEG/PNG photos and MP4/MOV videos up to 300 MB; WebP photos stay in `data/` only
  (`bodyos_skipped`). Videos are read from disk as they are sent, not loaded into memory.
- The API keeps its artifact list in memory: after it restarts, old URLs stop working even though
  its files stay on its disk.

Tested here against the real API (`codex/api` plus the video endpoint): a 4 MB JPEG and a 5-second
720p MP4 through the receiver, and a live RTMP stream stopped with Ctrl+C, all came back from
`/v1/artifacts/<id>` byte for byte; 5 of 5 demo-glasses screenshots were kept.

The rest of this page is the older route through the Mentra cloud (MentraOS app + ngrok).

## What is tested and what is not

| Part | Status |
|---|---|
| Saving events, photos, IMU samples; settings checks; photo/video logic; the live feed; the Wi-Fi receiver; sending photos and videos to the BodyOS API; cutting pictures from the live stream | Tested here (`npm test`, 46 tests; viewer `npm test`, 13 tests; both run in the repo's `make check`) |
| Video receiver (`scripts/record-video.sh`) | Tested here with a fake RTMP push: it made `recording.mp4`, frame screenshots and `latest.jpg` |
| `/imu` endpoint on the real MentraOS SDK server | Tested here: wrong token refused, good samples saved |
| **Real glasses end to end** (app registration, the tunnel, photos, the stream) | **Not tested.** No glasses were available. The SDK calls were checked against the installed `@mentra/sdk` 2.1.29 type files, not run against a pair of glasses |

Expect to fix small things on first contact with real glasses.

## The IMU gap (accelerometer and gyroscope)

I read both Mentra SDKs as published on npm:

- `@mentra/sdk` 2.1.29 (the one this tool uses): the only motion event is **head up / head down**.
  There is no raw accelerometer or gyroscope stream.
- `@mentra/bluetooth-sdk` 3.4.0: has a setting `setImuEnabled(true)` and a settings field `imu_enabled`,
  but its documented event list has **no event that carries IMU numbers**. Whether Mentra Live has an IMU at all
  is unconfirmed (the docs only expose a `hasIMU` capability flag, and this tool logs the glasses' capabilities
  at the start of each session in `events.jsonl` so you can read the answer).

So today this tool records the head up/down events and nothing more. To get real accel/gyro you would need
one of: a newer SDK or firmware that exposes it, Mentra's support or Discord, or a sensor of your own
(for example the Vexo band on the wrist). The `/imu` door below takes samples from any of those.

## Setup

You need: Node 20.12 or newer, `ffmpeg` (video only; macOS: `brew install ffmpeg`), an
[ngrok](https://ngrok.com) account with a static domain, the MentraOS phone app with the glasses paired.

1. In `mentra-glasses-tool/`: `npm install`
2. At [console.mentra.glass](https://console.mentra.glass) create an app: a unique package name such as
   `com.yourname.glassesrecorder`, Public URL = your ngrok static URL, and add the **camera** permission
   (the exact permission name was not checked: see Mentra's Permissions guide). Copy the app's API key.
3. `cp .env.example .env`, then fill in `PACKAGE_NAME` and `MENTRAOS_API_KEY`. The key lives only in `.env`.
   Never paste it into a chat or commit it.
4. `ngrok http --url=<your-static-domain> 3000` (the command's flags change between ngrok versions)
5. `npm start`, then open the app on the glasses (from the MentraOS phone app).

### Screenshots

Default: one photo every 10 seconds (`PHOTO_INTERVAL_SEC`), plus one on every short button press.
Each photo takes seconds over Bluetooth, so this is for snapshots, not a live feed. Photos are in
`data/<time>_<user>/photos/`.

### Video

Photos and video share one camera, so with `VIDEO=1` photos switch off and screenshots come from the video.

1. Set `VIDEO=1` in `.env`.
2. Terminal A: `npm run video` (waits for the glasses).
3. Terminal B: `npm start`, then open the app on the glasses.

The glasses push RTMP straight to this Mac, so **they must be on the same Wi-Fi as the Mac**
(RTMP from glasses to a local address is documented as possible but was not tried here).
The Mac's address is found automatically; set `RTMP_URL` if it picks the wrong one.
You get `data/video/<time>/recording.mp4`, `frames/` (one screenshot per second) and `latest.jpg`
(newest frame, twice a second): point your vision model at `latest.jpg`.
Only one stream can run at a time. If the app says the camera is busy, stop other Mentra apps.

### IMU samples from any source

Set `INGEST_TOKEN` (a long random value) in `.env`. Then any program can send samples:

```bash
curl -X POST http://localhost:3000/imu \
  -H "Content-Type: application/json" -H "X-Ingest-Token: $INGEST_TOKEN" \
  -d '{"ax":0,"ay":0,"az":1,"gx":0,"gy":0,"gz":0,"t":12345}'
```

A list of samples (up to 500) is accepted too. They land in `imu.jsonl` of the open glasses session.
The ngrok address is public, so keep the token secret; with `INGEST_TOKEN` empty the door is closed.

## See it live, and the photos and recordings

`viewer/` is a desktop app for that: `cd viewer`, `npm install`, `npm start`. See `viewer/README.md`.
Its **Live** page shows what the glasses send as it arrives, and can start and stop the recorder.
The recorder sends it a live feed on `http://127.0.0.1:3001` (`LIVE_PORT`; this computer only, never through ngrok).

No glasses yet? `npm run demo` runs pretend glasses through the same recording code: photos and events
every few seconds into `data/`, and into the viewer's Live page. No account, key or internet needed.

## What gets saved

```
data/<time>_<user>/
  events.jsonl   one JSON per line: session_start (with the glasses' capabilities), head_position,
                 button, touch, battery, photo, photo_error, stream_status, session_end
  imu.jsonl      raw samples, only if something sent them
  photos/        photo_000001_<ms>.jpg ...
data/video/<time>/
  recording.mp4  frames/  latest.jpg
```

Every record has `time` in milliseconds since 1970 (the Mac's clock when it arrived).
Line this up with other devices by measuring the delay yourself; none was measured here.

## Privacy

The camera light is on while photos or video are taken. Tell people near you before you record, and stop when
they ask. Recordings can contain faces and screens: keep `data/` off shared drives and out of git.

## Files

- `src/server.mjs`: the app server and the `/imu` door
- `src/recording.mjs`: records one session and passes its events to the live feed
- `src/live.mjs`: the live feed for the viewer (127.0.0.1 only)
- `src/demo.mjs`: pretend glasses (`npm run demo`)
- `src/receiver.mjs`: takes photos and videos straight from the glasses over Wi-Fi (`npm run receive`)
- `src/frames.mjs`: cuts every frame of the live stream into pictures and sends them on (`npm run frames`)
- `src/bodyos.mjs`: keeps photos and videos in the BodyOS API; `npm run send -- <files>`
- `src/session.mjs`: photos, events and video for one glasses session
- `src/store.mjs`: writes the files, checks IMU samples, keeps names safe
- `src/config.mjs`: reads and checks `.env`
- `scripts/record-video.sh`: the video receiver
- `test/`: `npm test`
- `viewer/`: the desktop app to look at the recordings
