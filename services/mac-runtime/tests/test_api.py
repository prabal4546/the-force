import io
from contextlib import ExitStack
from pathlib import Path
import tempfile
import unittest

from fastapi.testclient import TestClient
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from bodyos_mac.api import create_app


def photo_bytes(color="blue"):
    output = io.BytesIO()
    Image.new("RGB", (7, 5), color=color).save(output, format="PNG")
    return output.getvalue()


class DeviceAPITests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.storage = Path(self.directory.name) / "photos"
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.client = stack.enter_context(TestClient(create_app(upload_dir=self.storage, session_token="")))

    def register(self, device_id="vexo-76", device_type="band", **fields):
        return self.client.post("/v1/devices/connect", json={
            "device_id": device_id,
            "device_type": device_type,
            **fields,
        })

    def upload(self, request_id="capture-001", content=None, **options):
        return self.client.post(
            "/v1/glasses/photos?device_id=glasses-1",
            data={"requestId": request_id},
            files={"photo": ("../../outside.png", content if content is not None else photo_bytes(), "image/png")},
            **options,
        )

    def test_registration_does_not_claim_the_hardware_is_connected(self):
        response = self.register()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "registered")
        self.assertEqual(response.json()["hardware_status"], "unknown")
        state = self.client.get("/v1/devices/vexo-76").json()
        self.assertEqual(state["device_type"], "band")
        self.assertEqual(state["device_id"], "vexo-76")

    def test_reported_hardware_status_updates_without_changing_device_identity(self):
        self.register(hardware_status="connected")
        response = self.register(hardware_status="disconnected")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["hardware_status"], "disconnected")
        conflict = self.register(device_type="glasses")
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(self.client.get("/v1/devices/vexo-76").json()["device_type"], "band")

    def test_gesture_requires_a_registered_band(self):
        event = {"event_id": "gesture-001", "device_id": "vexo-76", "gesture": "double-tap"}
        self.assertEqual(self.client.post("/v1/gestures", json=event).status_code, 404)
        self.register(device_type="glasses")
        self.assertEqual(self.client.post("/v1/gestures", json=event).status_code, 409)

    def test_gesture_retry_is_idempotent_and_conflicting_event_is_rejected(self):
        self.register()
        event = {"event_id": "gesture-001", "device_id": "vexo-76", "gesture": "double-tap"}
        first = self.client.post("/v1/gestures", json=event)
        self.assertEqual(first.status_code, 202)
        self.assertEqual(first.json()["status"], "accepted")
        self.assertEqual(first.json()["event_id"], "gesture-001")
        repeated = self.client.post("/v1/gestures", json=event)
        self.assertEqual(repeated.status_code, 202)
        self.assertEqual(repeated.json(), first.json())
        conflict = self.client.post("/v1/gestures", json={**event, "gesture": "grab"})
        self.assertEqual(conflict.status_code, 409)

    def test_gesture_timestamp_requires_an_explicit_timezone(self):
        self.register()
        event = {"event_id": "gesture-001", "device_id": "vexo-76", "gesture": "double-tap"}
        invalid = self.client.post("/v1/gestures", json={**event, "timestamp": "2026-11-14T12:00:00"})
        self.assertEqual(invalid.status_code, 422)
        valid = self.client.post("/v1/gestures", json={**event, "timestamp": "2026-11-14T20:00:00Z"})
        self.assertEqual(valid.status_code, 202)

    def test_glasses_upload_returns_a_retrievable_image_and_ignores_client_filename(self):
        self.register("glasses-1", "glasses")
        content = photo_bytes()
        response = self.upload(content=content)
        self.assertEqual(response.status_code, 201)
        metadata = response.json()
        self.assertEqual(metadata["status"], "received")
        self.assertEqual(metadata["request_id"], "capture-001")
        self.assertEqual((metadata["width"], metadata["height"]), (7, 5))
        self.assertEqual(metadata["content_type"], "image/png")
        downloaded = self.client.get(metadata["photoUrl"])
        self.assertEqual(downloaded.status_code, 200)
        self.assertEqual(downloaded.content, content)
        self.assertEqual(len(list(self.storage.iterdir())), 1)
        self.assertFalse((Path(self.directory.name).parent / "outside.png").exists())

    def test_photo_retries_reuse_artifact_but_reject_conflicting_content(self):
        self.register("glasses-1", "glasses")
        first = self.upload()
        repeated = self.upload()
        self.assertEqual(first.status_code, 201)
        self.assertEqual(repeated.status_code, 201)
        self.assertEqual(first.json()["artifact_id"], repeated.json()["artifact_id"])
        conflict = self.upload(content=photo_bytes("red"))
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(len(list(self.storage.iterdir())), 1)

    def test_mentra_jpeg_upload_preserves_its_original_bytes_and_media_type(self):
        self.register("glasses-1", "glasses")
        output = io.BytesIO()
        Image.new("RGB", (7, 5), color="red").save(output, format="JPEG")
        content = output.getvalue()
        response = self.upload(content=content)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["content_type"], "image/jpeg")
        downloaded = self.client.get(response.json()["photoUrl"])
        self.assertEqual(downloaded.headers["content-type"], "image/jpeg")
        self.assertEqual(downloaded.content, content)

    def test_photo_requires_registered_glasses(self):
        self.assertEqual(self.upload().status_code, 404)
        self.register("glasses-1", "band")
        self.assertEqual(self.upload().status_code, 409)
        self.assertFalse(self.storage.exists())

    def test_invalid_photo_is_rejected_without_retaining_a_partial_file(self):
        self.register("glasses-1", "glasses")
        response = self.upload(content=b"not actually an image")
        self.assertEqual(response.status_code, 415)
        self.assertEqual(list(self.storage.iterdir()), [])

    def test_excessive_compressed_image_metadata_is_rejected_without_server_error(self):
        self.register("glasses-1", "glasses")
        metadata = PngInfo()
        metadata.add_text("oversized", "x" * (1024 * 1024 + 1), zip=True)
        image = io.BytesIO()
        Image.new("RGB", (7, 5), color="blue").save(image, format="PNG", pnginfo=metadata)
        response = self.upload(content=image.getvalue())
        self.assertEqual(response.status_code, 415)
        self.assertEqual(list(self.storage.iterdir()), [])

    def test_oversized_photo_is_rejected_and_partial_file_is_removed(self):
        with TestClient(create_app(upload_dir=self.storage, session_token="", max_upload_bytes=64)) as client:
            client.post("/v1/devices/connect", json={"device_id": "glasses-1", "device_type": "glasses"})
            response = client.post(
                "/v1/glasses/photos?device_id=glasses-1",
                data={"requestId": "capture-001"},
                files={"photo": ("photo.png", photo_bytes(), "image/png")},
            )
        self.assertEqual(response.status_code, 413)
        self.assertEqual(list(self.storage.iterdir()), [])

    def test_unknown_device_and_artifact_are_not_reported_as_available(self):
        self.assertEqual(self.client.get("/v1/devices/missing").status_code, 404)
        self.assertEqual(self.client.get("/v1/artifacts/missing").status_code, 404)

    def test_configured_session_token_protects_device_data(self):
        with TestClient(create_app(upload_dir=self.storage, session_token="test-session-token")) as client:
            self.assertEqual(client.get("/healthz").status_code, 200)
            body = {"device_id": "vexo-76", "device_type": "band"}
            self.assertEqual(client.post("/v1/devices/connect", json=body).status_code, 401)
            authorized = client.post("/v1/devices/connect", json=body, headers={"Authorization": "Bearer test-session-token"})
            self.assertEqual(authorized.status_code, 200)
            self.assertEqual(client.get("/v1/devices/vexo-76").status_code, 401)


if __name__ == "__main__":
    unittest.main()
