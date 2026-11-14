# Vexo band 28: motion check and simple dashboard

Two small things that talk to our Vexo band (`Vexo-HACK-28`) over Bluetooth:

- `band_check.py` prints one motion reading a second for 30 seconds, plus taps.
- `index.html` is a dashboard page: connect, battery, six live motion graphs, tap log.

## Setup

You need Python 3.9 or newer, and Chrome or Edge for the dashboard.

1. Clone this branch, then clone the Vexo kit inside it. Both files expect the kit in a
   folder named `vexo-open-kit` next to them.

       git clone -b band-dashboard https://github.com/wongywrongy/group-vexo-open-kit.git vexo-remote
       cd vexo-remote
       git clone https://github.com/wongywrongy/group-vexo-open-kit.git vexo-open-kit

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

    python3 -m http.server 8000 --bind 127.0.0.1

Then open <http://localhost:8000/index.html> in Chrome or Edge, press **Connect** and pick
`Vexo-HACK-28` in the list. To try it without the band, open
<http://localhost:8000/index.html?sim> instead.

## Using a different band

Change `BAND = 28` near the top of both `band_check.py` and `index.html`.
