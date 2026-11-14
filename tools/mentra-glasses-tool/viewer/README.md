# Glasses Viewer

A desktop app (Electron + React) for `mentra-glasses-tool`: start it, watch the glasses' screenshots
arrive **live**, and look through every screenshot it saved.

## Live

The **Live** page (top of the sidebar):

- **Receive from glasses** with **fast screenshots** ticked (the default) starts the Wi-Fi receiver
  (`npm run receive`) and the fast-screenshot cutter (`npm run frames`). It shows two addresses with
  Copy buttons:
  - *Stream*: paste into Mentra's example app, **Stream** screen. Every frame of the stream becomes a
    screenshot, in `data/` and (with `BODYOS_API_URL` set) in the team's device API on `codex/api`.
  - *Media upload URL*: Mentra's app, **Camera** screen, **Use cloud server**: single photos.
- **Cloud recorder** is the SDK route through the MentraOS app and ngrok (needs `.env`); with
  **fast screenshots** ticked it asks the glasses to stream (`STREAM=1`) and runs `npm run frames` too.
- **Try demo glasses** starts pretend glasses (`npm run demo`): a picture every few seconds, with no
  glasses, account or internet. Use it to check everything works.
- While it runs: the status (*Recorder off*, *Waiting for glasses*, *Glasses connected*), the newest
  screenshot (twice a second while the stream runs), the glasses' battery and head up/down on the
  SDK route, everything that arrives, newest first, **Stop**, and the recorder's output.

The recorder sends the live feed on `http://127.0.0.1:3001` (this computer only; never through ngrok).
If you change `LIVE_PORT` in the recorder's `.env`, the app reads it from there.
A recorder started in a terminal (`npm run frames`, `npm start`, `npm run demo`) shows up here too.

## Saved screenshots

- **Screenshot sessions**: one per run, all screenshots in a grid (the newest 600 of a big run, with the
  total); click one for full size, ← → to move, Esc to close. **LIVE** marks a run still receiving.
- **Events**: each screenshot and where the API kept it, head up/down, button, touch, battery, with filters.

It picks up new screenshots by itself every 2 seconds. "Show in Finder" opens the file's folder.

## Run it

Needs Node 20.12 or newer. In `mentra-glasses-tool/viewer`:

```bash
npm install
```

```bash
npm start
```

`npm start` builds the page and opens the window. It reads `mentra-glasses-tool/data` unless you pick
another folder with the **Data folder** button (the choice is remembered), or start it with
`GLASSES_DATA_DIR=/path/to/data npm start`.

## Tested

- `npm test`: 13 tests (reading the folder and a big run's newest screenshots, refusing files outside
  it, the live feed reader and reconnecting, which processes each start button runs).
- The page builds (`vite build`). The app window itself was last driven by hand before the switch to
  screenshots only; not tried on a Mac display since, nor with real glasses.

## How it is built

- `electron/main.cjs`: the window, and the `media://` address that serves screenshots to the page.
  Only pictures inside the data folder are served (symlinks out of it are refused).
- `electron/library.cjs`: reads the data folder (no Electron in it, so it is tested with plain Node)
- `electron/live-client.cjs`: listens to the recorder's live feed and reconnects by itself
- `electron/processes.cjs`: starts and stops the recorder, the demo and `npm run frames`
- `electron/preload.cjs`: the things the page may ask for
- `src/App.jsx`, `src/styles.css`: the React screens
