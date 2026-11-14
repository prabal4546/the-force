# Prove the band streams motion: one line a second for 30 seconds, plus taps.
#   python band_check.py              the real band, over Bluetooth
#   python band_check.py --sim        the pretend band, no hardware
#   python band_check.py --band 76    another band (the XX in Vexo-HACK-XX)
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent / "vexo-open-kit" / "python"))   # the library: a folder in the kit
from vexo_open.sync import Band

BAND = int(sys.argv[sys.argv.index("--band") + 1]) if "--band" in sys.argv else 28   # the XX in Vexo-HACK-XX
SECONDS = 30

latest = None                             # the newest motion reading


def on_motion(m):                         # runs 100 times a second: only keep the reading
    global latest
    latest = m


if "--sim" in sys.argv:
    band = Band.connect(BAND, transport="sim", auto_reconnect=True)
else:
    band = Band.connect(BAND, auto_reconnect=True)
print("Connected to", band.name)

band.set_motion(accel_range=8)            # measure up to 8 g
band.on("motion", on_motion)
band.on("tap", lambda e: print("tap"))
band.on("double-tap", lambda e: print("double-tap"))
band.configure(motion=100, events=True)   # nothing arrives until it is turned on

for second in range(1, SECONDS + 1):
    band.wait(1)
    m = latest
    if m is None:
        print("%2d  no motion reading yet" % second)
    else:
        print("%2d  ax %+.2f  ay %+.2f  az %+.2f   gx %+7.1f  gy %+7.1f  gz %+7.1f"
              % (second, m.ax, m.ay, m.az, m.gx, m.gy, m.gz))

band.disconnect()
print("Disconnected.")
