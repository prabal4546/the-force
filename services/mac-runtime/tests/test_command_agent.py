import io
from contextlib import ExitStack
from pathlib import Path
import tempfile
import unittest

from fastapi.testclient import TestClient
from PIL import Image

from bodyos_mac.agent import SimulatedAgent
from bodyos_mac.api import create_app


def png_bytes(color="blue"):
    out = io.BytesIO()
    Image.new("RGB", (8, 6), color=color).save(out, format="PNG")
    return out.getvalue()


class CountingAgent(SimulatedAgent):
    """Offline brain that records how many turns it actually ran."""

    def __init__(self) -> None:
        self.calls = 0

    def run_turn(self, *args, **kwargs):
        self.calls += 1
        return super().run_turn(*args, **kwargs)


class CommandAgentTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.agent = CountingAgent()
        self.app = create_app(
            upload_dir=Path(directory.name) / "photos",
            session_token="",
            agent=self.agent,
            memory_db=Path(directory.name) / "agent_memory.sqlite3",
        )
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.client = stack.enter_context(TestClient(self.app))
        self.client.post("/v1/devices/connect", json={"device_id": "band-1", "device_type": "band"})
        self.client.post("/v1/devices/connect", json={"device_id": "glasses-1", "device_type": "glasses"})

    def upload_photo(self, request_id="shot-1"):
        return self.client.post(
            "/v1/glasses/photos?device_id=glasses-1",
            data={"requestId": request_id},
            files={"photo": ("view.png", png_bytes(), "image/png")},
        )

    def send_command(self, text, **options):
        return self.client.post(
            "/v1/band/events?device_id=band-1", json={"type": "command", "text": text}, **options
        )

    def turn(self, event_id):
        return self.client.get(f"/v1/agent/turns/{event_id}?device_id=band-1")

    def test_command_runs_a_turn_referencing_the_latest_photo(self):
        # TestClient runs background tasks before returning, so the turn is done.
        artifact_id = self.upload_photo().json()["artifact_id"]
        res = self.send_command("我面前是什么？")
        self.assertEqual(res.status_code, 202, res.text)
        event_id = res.json()["event_id"]
        body = self.turn(event_id)
        self.assertEqual(body.status_code, 200, body.text)
        data = body.json()
        self.assertEqual(data["status"], "completed")
        self.assertEqual(data["tool"], "answer")
        self.assertEqual(data["image_artifact_id"], artifact_id)
        self.assertEqual(self.agent.calls, 1)
        mem = self.client.get("/v1/agent/memory?device_id=band-1").json()
        self.assertEqual(len(mem["recent_turns"]), 1)

    def test_command_without_a_photo_still_answers(self):
        res = self.send_command("你好")
        data = self.turn(res.json()["event_id"]).json()
        self.assertEqual(data["status"], "completed")
        self.assertIsNone(data["image_artifact_id"])

    def test_remember_adds_a_fact(self):
        self.send_command("记住这是我的工位")
        mem = self.client.get("/v1/agent/memory?device_id=band-1").json()
        self.assertIn("记住这是我的工位", mem["facts"])

    def test_retry_does_not_run_a_second_turn(self):
        headers = {"Idempotency-Key": "cmd-001"}
        first = self.send_command("我面前是什么？", headers=headers)
        repeated = self.send_command("我面前是什么？", headers=headers)
        self.assertEqual(repeated.json(), first.json())
        self.assertEqual(self.agent.calls, 1)

    def test_non_command_events_do_not_run_the_brain(self):
        for payload in ({"type": "step", "direction": 1}, {"type": "toggle"}, {"type": "select"}):
            self.client.post("/v1/band/events?device_id=band-1", json=payload)
        self.assertEqual(self.agent.calls, 0)

    def test_turn_is_unknown_before_dispatch(self):
        self.assertEqual(self.turn("never-dispatched").status_code, 404)


if __name__ == "__main__":
    unittest.main()
