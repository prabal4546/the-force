from contextlib import ExitStack
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from fastapi.testclient import TestClient

from bodyos_mac.agent import SimulatedAgent
from bodyos_mac.api import create_app


class FreshPhotoTests(unittest.TestCase):
    """A spoken command asks the glasses for a new photo before the brain runs."""

    def build(self, fresh_photo, timeout=12.0):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.app = create_app(
            upload_dir=self.directory / "photos",
            session_token="",
            agent=SimulatedAgent(),
            memory_db=self.directory / "agent_memory.sqlite3",
            fresh_photo=fresh_photo,
            fresh_photo_timeout=timeout,
        )
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.client = stack.enter_context(TestClient(self.app))
        self.client.post("/v1/devices/connect", json={"device_id": "band-1", "device_type": "band"})

    def add_photo(self, artifact_id, content):
        # Stands in for the bridge's upload landing while the hook is awaited.
        path = self.directory / f"{artifact_id}.jpg"
        path.write_bytes(content)
        self.app.state.artifacts[artifact_id] = {
            "metadata": SimpleNamespace(artifact_id=artifact_id, content_type="image/jpeg"),
            "path": path,
            "digest": artifact_id,
        }

    def run_command(self):
        event_id = self.client.post(
            "/v1/band/events?device_id=band-1", json={"type": "command", "text": "what is this?"}
        ).json()["event_id"]
        return self.client.get(f"/v1/agent/turns/{event_id}?device_id=band-1").json()

    def test_the_brain_sees_the_photo_taken_for_the_command(self):
        async def fresh_photo():
            self.add_photo("fresh", b"new view")

        self.build(fresh_photo)
        self.add_photo("stale", b"old")
        turn = self.run_command()
        self.assertEqual(turn["status"], "completed")
        self.assertEqual(turn["image_artifact_id"], "fresh")
        self.assertIn("image 8 bytes", turn["understanding"])

    def test_a_bridge_that_is_not_running_falls_back_to_the_last_photo(self):
        async def fresh_photo():
            raise ConnectionRefusedError("bridge is not running")

        self.build(fresh_photo)
        self.add_photo("stale", b"old")
        turn = self.run_command()
        self.assertEqual(turn["status"], "completed")
        self.assertEqual(turn["image_artifact_id"], "stale")

    def test_a_slow_bridge_does_not_hold_the_answer(self):
        import asyncio

        async def fresh_photo():
            await asyncio.sleep(5)

        self.build(fresh_photo, timeout=0.05)
        self.add_photo("stale", b"old")
        turn = self.run_command()
        self.assertEqual(turn["image_artifact_id"], "stale")
