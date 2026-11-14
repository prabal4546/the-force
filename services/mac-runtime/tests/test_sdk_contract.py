import io
from pathlib import Path
import sys
import tempfile
import unittest

from fastapi.testclient import TestClient
from PIL import Image

from bodyos_mac.api import create_app


SDK_ROOT = Path(__file__).resolve().parents[3] / "vendor/vexo-open-kit/python"
sys.path.insert(0, str(SDK_ROOT))

from vexo_open import Band, SimTransport


class VexoSDKContractTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.transport = SimTransport(1, realtime=False, auto_tap=False)
        self.band = await Band.connect(1, transport=self.transport)
        self.addAsyncCleanup(self.band.disconnect)

    async def test_sdk_tap_kinds_can_feed_the_teammate_intake(self):
        events = []
        self.band.on("event", events.append)
        await self.band.configure(events=True)
        self.assertTrue(self.transport.tap("tap"))
        self.assertTrue(self.transport.tap("double-tap"))
        self.assertEqual([event["kind"] for event in events], ["tap", "double-tap"])
        with TestClient(create_app(session_token="")) as client:
            client.post("/v1/devices/connect", json={
                "device_id": "band-simulator", "device_type": "band",
            })
            for event in events:
                payload = {"type": {"tap": "toggle", "double-tap": "select"}[event["kind"]]}
                response = client.post("/v1/band/events?device_id=band-simulator", json=payload)
                self.assertEqual(response.status_code, 202, response.text)

    async def test_sdk_motion_exposes_raw_axes_not_custom_gesture_labels(self):
        samples = []
        self.band.on("motion", samples.append)
        await self.band.configure(motion=50)
        self.transport.play_motion({"ax": 0, "ay": 0, "az": 1, "gx": 0, "gy": 0, "gz": 200}, seconds=0.2)
        self.transport.step(200)
        self.assertTrue(samples)
        for sample in samples:
            self.assertTrue({"ax", "ay", "az", "gx", "gy", "gz", "t", "time"}.issubset(sample))
            self.assertAlmostEqual(sample["gz"], 200)
            self.assertNotIn("delta", sample)
            self.assertNotIn("direction", sample)

    async def test_sdk_audio_is_opus_not_a_speech_transcript(self):
        packets = []
        self.band.on("audio", packets.append)
        await self.band.configure(audio=True)
        self.transport.step(100)
        self.assertTrue(packets)
        self.assertIsInstance(packets[0]["opus"], bytes)
        self.assertNotIn("text", packets[0])
        await self.band.configure(audio=False)


class MentraUploadContractTests(unittest.TestCase):
    def test_documented_webhook_fields_accept_jpeg_and_auth_token(self):
        image = io.BytesIO()
        Image.new("RGB", (640, 480), color="blue").save(image, format="JPEG")
        jpeg = image.getvalue()
        with tempfile.TemporaryDirectory() as directory:
            with TestClient(create_app(upload_dir=Path(directory), session_token="mentra-test-token")) as client:
                headers = {"Authorization": "Bearer mentra-test-token"}
                client.post("/v1/devices/connect", json={
                    "device_id": "glasses-test", "device_type": "glasses",
                }, headers=headers)
                response = client.post(
                    "/v1/glasses/photos?device_id=glasses-test",
                    headers=headers,
                    data={"requestId": "mentra-capture-test"},
                    files={"photo": ("photo.jpg", jpeg, "image/jpeg")},
                )
                self.assertEqual(response.status_code, 201, response.text)
                result = response.json()
                self.assertEqual(result["request_id"], "mentra-capture-test")
                self.assertEqual(result["status"], "received")
                self.assertEqual((result["width"], result["height"]), (640, 480))
                self.assertEqual(result["size_bytes"], len(jpeg))
                self.assertEqual(client.get(result["photoUrl"]).status_code, 401)
                download = client.get(result["photoUrl"], headers=headers)
                self.assertEqual(download.headers["content-type"], "image/jpeg")
                self.assertEqual(download.content, jpeg)
