from concurrent.futures import ThreadPoolExecutor, TimeoutError
from contextlib import ExitStack
import os
from pathlib import Path
import tempfile
from threading import Event
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from bodyos_mac.api import create_app
from bodyos_mac.command_store import CommandStore


class CommandAPITests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.database = self.root / "commands.sqlite3"
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.client = self.new_client()
        self.register(self.client)

    def new_client(self, token="", database=None):
        with patch.dict(os.environ, {"BODYOS_COMMAND_DB": str(database or self.database)}):
            app = create_app(upload_dir=self.root / "photos", session_token=token)
        return self.stack.enter_context(TestClient(app))

    def register(self, client, device_id="band-voice", device_type="band", headers=None):
        return client.post("/v1/devices/connect", json={
            "device_id": device_id, "device_type": device_type,
        }, headers=headers)

    def submit(self, text="set a ten minute timer", key=None, endpoint="/v1/commands", client=None):
        return (client or self.client).post(
            endpoint + "?device_id=band-voice",
            json={"type": "command", "text": text},
            headers={"Idempotency-Key": key} if key else {},
        )

    def test_dedicated_intake_stores_the_raw_transcript_without_executing_it(self):
        text = "  Set a ten minute timer.  "
        accepted = self.submit(text)
        self.assertEqual(accepted.status_code, 202, accepted.text)
        self.assertEqual(accepted.json()["status"], "accepted")
        self.assertIn("command_id", accepted.json())
        record = self.client.get("/v1/commands/" + accepted.json()["command_id"])
        self.assertEqual(record.status_code, 200)
        self.assertEqual(record.json()["text"], text)
        self.assertEqual(record.json()["device_id"], "band-voice")
        self.assertEqual(record.json()["event_id"], accepted.json()["event_id"])
        self.assertEqual(record.json()["received_at"], accepted.json()["received_at"])
        self.assertEqual(record.json()["status"], "received")
        self.assertTrue(self.database.is_file())

    def test_existing_band_endpoint_and_dedicated_endpoint_share_durable_deduplication(self):
        first = self.submit(key="utterance-001", endpoint="/v1/band/events")
        self.assertEqual(first.status_code, 202)
        self.assertIn("command_id", first.json())
        repeated = self.submit(key="utterance-001")
        self.assertEqual(repeated.status_code, 202)
        self.assertEqual(first.json(), repeated.json())
        self.assertEqual(len(self.client.get("/v1/commands").json()), 1)
        self.assertEqual(self.submit("different transcript", key="utterance-001").status_code, 409)

    def test_records_and_retry_responses_survive_application_restart(self):
        accepted = self.submit(key="utterance-001")
        self.assertEqual(accepted.status_code, 202)
        restarted = self.new_client()
        record = restarted.get("/v1/commands/" + accepted.json()["command_id"])
        self.assertEqual(record.status_code, 200)
        self.assertEqual(record.json()["text"], "set a ten minute timer")
        self.register(restarted)
        self.assertEqual(self.submit(key="utterance-001", client=restarted).json(), accepted.json())
        self.assertEqual(self.submit("changed", key="utterance-001", client=restarted).status_code, 409)
        self.assertEqual(len(restarted.get("/v1/commands").json()), 1)

    def test_identical_transcripts_without_retry_keys_are_distinct_utterances(self):
        first = self.submit()
        second = self.submit()
        self.assertEqual(first.status_code, 202)
        self.assertEqual(second.status_code, 202)
        self.assertNotEqual(first.json()["command_id"], second.json()["command_id"])
        self.assertEqual(len(self.client.get("/v1/commands").json()), 2)

    def test_retry_keys_are_scoped_to_the_device(self):
        first = self.submit(key="utterance-001")
        self.assertEqual(first.status_code, 202)
        self.register(self.client, "band-second")
        second = self.client.post("/v1/commands?device_id=band-second", json={
            "type": "command", "text": "different words",
        }, headers={"Idempotency-Key": "utterance-001"})
        self.assertEqual(second.status_code, 202)
        self.assertNotEqual(first.json()["command_id"], second.json()["command_id"])

    def test_history_is_bounded_newest_first_and_filterable_by_device(self):
        first = self.submit("first")
        second = self.submit("second")
        self.assertEqual(first.status_code, 202)
        self.assertEqual(second.status_code, 202)
        self.register(self.client, "band-second")
        self.client.post("/v1/commands?device_id=band-second", json={"type": "command", "text": "third"})
        self.assertEqual([record["text"] for record in self.client.get("/v1/commands?limit=2").json()], ["third", "second"])
        self.assertEqual([record["text"] for record in self.client.get("/v1/commands?device_id=band-voice").json()], ["second", "first"])
        self.assertEqual([record["text"] for record in self.client.get("/v1/commands?limit=1&offset=2").json()], ["first"])
        self.assertEqual(self.client.get("/v1/commands?device_id=missing").json(), [])
        for query in ("limit=0", "limit=101", "offset=-1"):
            self.assertEqual(self.client.get("/v1/commands?" + query).status_code, 422)

    def test_unknown_command_and_empty_history_do_not_claim_success(self):
        self.assertEqual(self.client.get("/v1/commands").json(), [])
        self.assertEqual(self.client.get("/v1/commands/missing").status_code, 404)

    def test_only_registered_bands_can_submit_completed_transcripts(self):
        self.assertEqual(self.client.post("/v1/commands?device_id=missing", json={
            "type": "command", "text": "hello",
        }).status_code, 404)
        self.register(self.client, "glasses-test", "glasses")
        self.assertEqual(self.client.post("/v1/commands?device_id=glasses-test", json={
            "type": "command", "text": "hello",
        }).status_code, 409)
        for payload in ({"type": "say", "text": "Lamp"}, {"type": "toggle"},
                        {"type": "command", "text": "  "}, {"type": "command", "text": "x" * 4001},
                        {"type": "command", "text": "hello", "audio": "not-supported"}):
            with self.subTest(payload=payload):
                self.assertEqual(self.client.post("/v1/commands?device_id=band-voice", json=payload).status_code, 422)
        self.assertEqual(self.client.get("/v1/commands").json(), [])

    def test_command_write_and_history_require_the_configured_session_token(self):
        client = self.new_client(token="voice-test-token")
        headers = {"Authorization": "Bearer voice-test-token"}
        self.register(client, headers=headers)
        accepted = client.post("/v1/commands?device_id=band-voice", json={
            "type": "command", "text": "hello",
        }, headers=headers)
        self.assertEqual(accepted.status_code, 202)
        command_url = "/v1/commands/" + accepted.json()["command_id"]
        self.assertEqual(client.get(command_url).status_code, 401)
        self.assertEqual(client.get("/v1/commands").status_code, 401)
        self.assertEqual(self.submit(client=client).status_code, 401)
        self.assertEqual(client.get(command_url, headers=headers).status_code, 200)

    def test_storage_failure_returns_unavailable_instead_of_acceptance(self):
        invalid_database = self.root / "database-is-a-directory"
        invalid_database.mkdir()
        client = self.new_client(database=invalid_database)
        self.register(client)
        self.assertEqual(self.submit(client=client).status_code, 503)
        self.assertEqual(client.get("/v1/commands").status_code, 503)
        self.assertEqual(client.get("/v1/commands/missing").status_code, 503)

    def test_concurrent_retries_create_one_record(self):
        with ThreadPoolExecutor(max_workers=6) as executor:
            responses = list(executor.map(lambda _: self.submit(key="utterance-concurrent"), range(12)))
        self.assertTrue(all(response.status_code == 202 for response in responses))
        self.assertEqual(len({response.json()["command_id"] for response in responses}), 1)
        self.assertEqual(len(self.client.get("/v1/commands").json()), 1)

    def test_commands_cannot_reuse_a_cached_gesture_retry_key(self):
        gesture = self.client.post("/v1/band/events?device_id=band-voice", json={
            "type": "toggle",
        }, headers={"Idempotency-Key": "event-shared"})
        self.assertEqual(gesture.status_code, 202)
        self.assertEqual(self.submit(key="event-shared").status_code, 409)

    def test_separate_application_instances_deduplicate_through_sqlite(self):
        other = self.new_client()
        self.register(other)

        def submit_from_instance(index):
            client = self.client if index % 2 else other
            return self.submit(key="shared-instance-event", client=client)

        with ThreadPoolExecutor(max_workers=6) as executor:
            responses = list(executor.map(submit_from_instance, range(12)))
        self.assertTrue(all(response.status_code == 202 for response in responses))
        self.assertEqual(len({response.json()["command_id"] for response in responses}), 1)
        self.assertEqual(len(other.get("/v1/commands").json()), 1)

    def test_gestures_cannot_reuse_a_persisted_command_key_after_restart(self):
        accepted = self.submit(key="event-shared")
        self.assertEqual(accepted.status_code, 202)
        restarted = self.new_client()
        self.register(restarted)
        conflict = restarted.post("/v1/band/events?device_id=band-voice", json={
            "type": "toggle",
        }, headers={"Idempotency-Key": "event-shared"})
        self.assertEqual(conflict.status_code, 409)

    def test_slow_command_write_cannot_race_a_different_gesture_with_the_same_key(self):
        started = Event()
        release = Event()
        original_accept = CommandStore.accept

        def delayed_accept(store, *arguments):
            started.set()
            if not release.wait(timeout=5):
                raise RuntimeError("Storage test did not release the write")
            return original_accept(store, *arguments)

        def send_gesture():
            return self.client.post("/v1/band/events?device_id=band-voice", json={
                "type": "toggle",
            }, headers={"Idempotency-Key": "event-race"})

        with patch.object(CommandStore, "accept", delayed_accept):
            with ThreadPoolExecutor(max_workers=2) as executor:
                command = executor.submit(self.submit, key="event-race")
                self.assertTrue(started.wait(timeout=3))
                gesture = executor.submit(send_gesture)
                try:
                    gesture.result(timeout=0.2)
                except TimeoutError:
                    pass
                finally:
                    release.set()
                self.assertEqual(sorted([command.result().status_code, gesture.result().status_code]), [202, 409])

    def test_sql_like_transcript_is_saved_as_data_not_executed(self):
        text = "set a timer'); DROP TABLE commands; --"
        accepted = self.submit(text)
        self.assertEqual(accepted.status_code, 202)
        record = self.client.get("/v1/commands/" + accepted.json()["command_id"])
        self.assertEqual(record.json()["text"], text)
        self.assertEqual(self.submit("next command").status_code, 202)
        self.assertEqual(len(self.client.get("/v1/commands").json()), 2)

    def test_failed_write_does_not_leave_an_accepted_retry_in_memory(self):
        invalid_database = self.root / "retry-database"
        invalid_database.mkdir()
        client = self.new_client(database=invalid_database)
        self.register(client)
        self.assertEqual(self.submit(client=client, key="retry-after-failure", endpoint="/v1/band/events").status_code, 503)
        invalid_database.rmdir()
        accepted = self.submit(client=client, key="retry-after-failure", endpoint="/v1/band/events")
        self.assertEqual(accepted.status_code, 202)
        self.assertEqual(len(client.get("/v1/commands").json()), 1)
