from contextlib import ExitStack
from pathlib import Path
import tempfile
import unittest

from fastapi.testclient import TestClient

from bodyos_mac.api import create_app
from bodyos_mac.window_controller import SimulatedWindowMover
from bodyos_mac.window_geometry import Display, Rect


class CountingMover(SimulatedWindowMover):
    """Simulated mover that also counts how often it actually moved."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.move_count = 0

    def move_focused_window(self, direction: int):
        self.move_count += 1
        return super().move_focused_window(direction)


class BandMoveTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.mover = CountingMover()
        self.app = create_app(
            upload_dir=Path(directory.name), session_token="",
            command_db=Path(directory.name) / "commands.sqlite3",
            window_mover=self.mover,
        )
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.client = stack.enter_context(TestClient(self.app))
        self.client.post("/v1/devices/connect", json={
            "device_id": "band-test", "device_type": "band",
        })

    def send(self, payload, **options):
        return self.client.post(
            "/v1/band/events?device_id=band-test", json=payload, **options
        )

    def result_for(self, event_id):
        return self.client.get(
            f"/v1/band/events/{event_id}/result?device_id=band-test"
        )

    def test_right_swipe_moves_the_focused_window(self):
        # TestClient runs background tasks before returning, so the move has
        # already resolved by the time we read the result.
        response = self.send({"type": "step", "direction": 1})
        self.assertEqual(response.status_code, 202)
        event_id = response.json()["event_id"]

        result = self.result_for(event_id)
        self.assertEqual(result.status_code, 200, result.text)
        body = result.json()
        self.assertEqual(body["status"], "completed")
        self.assertEqual(body["direction"], 1)
        self.assertEqual(body["source_display"], 0)
        self.assertEqual(body["target_display"], 1)
        self.assertEqual(self.mover.move_count, 1)

    def test_left_swipe_with_no_display_reports_no_target(self):
        response = self.send({"type": "step", "direction": -1})
        event_id = response.json()["event_id"]
        body = self.result_for(event_id).json()
        self.assertEqual(body["status"], "no_target")
        self.assertIn("left", body["detail"])

    def test_retry_does_not_move_the_window_twice(self):
        headers = {"Idempotency-Key": "swipe-001"}
        first = self.send({"type": "step", "direction": 1}, headers=headers)
        repeated = self.send({"type": "step", "direction": 1}, headers=headers)
        self.assertEqual(first.status_code, 202)
        self.assertEqual(repeated.json(), first.json())
        # The duplicate delivery must not trigger a second move.
        self.assertEqual(self.mover.move_count, 1)

    def test_toggle_and_select_do_not_move_windows(self):
        toggle = self.send({"type": "toggle"})
        select = self.send({"type": "select"})
        self.assertEqual(toggle.status_code, 202)
        self.assertEqual(select.status_code, 202)
        self.assertEqual(self.mover.move_count, 0)
        # No move result is recorded for non-step events.
        self.assertEqual(self.result_for(toggle.json()["event_id"]).status_code, 404)

    def test_result_is_unknown_for_unseen_event(self):
        self.assertEqual(self.result_for("never-sent").status_code, 404)

    def test_reverse_swipe_moves_back_to_the_first_display(self):
        there = self.send({"type": "step", "direction": 1}).json()["event_id"]
        self.assertEqual(self.result_for(there).json()["target_display"], 1)
        back = self.send({"type": "step", "direction": -1}).json()["event_id"]
        self.assertEqual(self.result_for(back).json()["target_display"], 0)


if __name__ == "__main__":
    unittest.main()
