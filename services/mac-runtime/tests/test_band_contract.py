from contextlib import ExitStack
from pathlib import Path
import tempfile
import unittest

from fastapi.testclient import TestClient

from bodyos_mac.api import create_app


class BandContractTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.app = create_app(upload_dir=Path(directory.name), session_token="")
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.client = stack.enter_context(TestClient(self.app))
        self.client.post("/v1/devices/connect", json={
            "device_id": "band-test", "device_type": "band",
        })

    def send(self, payload, **options):
        return self.client.post("/v1/band/events?device_id=band-test", json=payload, **options)

    def test_teammate_payloads_are_accepted_without_invented_sdk_fields(self):
        payloads = [
            {"type": "adjust", "delta": 0.05},
            {"type": "adjust", "delta": -1.0},
            {"type": "adjust", "delta": 1.0},
            {"type": "step", "direction": -1},
            {"type": "step", "direction": 1},
            {"type": "toggle"},
            {"type": "select"},
            {"type": "command", "text": "set a ten minute timer"},
        ]
        identifiers = set()
        for payload in payloads:
            with self.subTest(payload=payload):
                response = self.send(payload)
                self.assertEqual(response.status_code, 202, response.text)
                result = response.json()
                self.assertEqual(result["status"], "accepted")
                self.assertEqual(result["device_id"], "band-test")
                self.assertTrue(result["received_at"])
                self.assertTrue(result["event_id"])
                identifiers.add(result["event_id"])
        self.assertEqual(len(identifiers), len(payloads))

    def test_invalid_values_are_rejected_instead_of_coerced(self):
        payloads = [
            {"type": "adjust", "delta": 1.01},
            {"type": "adjust", "delta": -1.01},
            {"type": "adjust", "delta": True},
            {"type": "adjust", "delta": "0.05"},
            {"type": "adjust"},
            {"type": "step", "direction": 0},
            {"type": "step", "direction": 2},
            {"type": "step", "direction": True},
            {"type": "step", "direction": "1"},
            {"type": "step", "direction": 1.0},
            {"type": "step", "direction": 0.5},
            {"type": "toggle", "direction": 1},
            {"type": "command", "text": "   "},
            {"type": "command", "text": "x" * 4001},
            {"type": "command", "text": 123},
            {"type": "say", "text": "Lamp"},
            {"type": "grab"},
        ]
        for payload in payloads:
            with self.subTest(payload=payload):
                self.assertEqual(self.send(payload).status_code, 422)

    def test_nonfinite_adjust_is_rejected(self):
        response = self.client.post(
            "/v1/band/events?device_id=band-test",
            content='{"type":"adjust","delta":1e999}',
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(response.status_code, 422)

    def test_optional_retry_key_deduplicates_and_detects_changed_payloads(self):
        headers = {"Idempotency-Key": "event-001"}
        first = self.send({"type": "adjust", "delta": 0.05}, headers=headers)
        repeated = self.send({"type": "adjust", "delta": 0.05}, headers=headers)
        self.assertEqual(first.status_code, 202)
        self.assertEqual(repeated.json(), first.json())
        conflict = self.send({"type": "adjust", "delta": 0.1}, headers=headers)
        self.assertEqual(conflict.status_code, 409)

    def test_retry_keys_are_scoped_to_each_band(self):
        self.client.post("/v1/devices/connect", json={
            "device_id": "band-second", "device_type": "band",
        })
        headers = {"Idempotency-Key": "event-001"}
        first = self.send({"type": "toggle"}, headers=headers)
        second = self.client.post(
            "/v1/band/events?device_id=band-second",
            json={"type": "select"}, headers=headers,
        )
        self.assertEqual(first.status_code, 202)
        self.assertEqual(second.status_code, 202)
        self.assertNotEqual(first.json()["device_id"], second.json()["device_id"])

    def test_band_identity_is_required_and_must_be_registered_as_band(self):
        self.assertEqual(self.client.post("/v1/band/events", json={"type": "toggle"}).status_code, 422)
        self.assertEqual(self.client.post(
            "/v1/band/events?device_id=missing", json={"type": "toggle"},
        ).status_code, 404)
        self.client.post("/v1/devices/connect", json={
            "device_id": "glasses-test", "device_type": "glasses",
        })
        self.assertEqual(self.client.post(
            "/v1/band/events?device_id=glasses-test", json={"type": "toggle"},
        ).status_code, 409)

    def test_band_intake_uses_the_configured_session_credential(self):
        with TestClient(create_app(session_token="test-token")) as client:
            headers = {"Authorization": "Bearer test-token"}
            client.post("/v1/devices/connect", json={
                "device_id": "band-test", "device_type": "band",
            }, headers=headers)
            url = "/v1/band/events?device_id=band-test"
            self.assertEqual(client.post(url, json={"type": "toggle"}).status_code, 401)
            self.assertEqual(client.post(url, json={"type": "toggle"}, headers=headers).status_code, 202)

    def test_openapi_advertises_only_the_two_supported_directions(self):
        schema = self.client.get("/openapi.json").json()
        direction = schema["components"]["schemas"]["StepInput"]["properties"]["direction"]
        self.assertEqual(direction["enum"], [-1, 1])
