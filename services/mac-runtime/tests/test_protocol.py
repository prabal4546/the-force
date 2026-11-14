import json
import unittest

from bodyos_mac.protocol import ProtocolError, WireMessage, reply


class WireMessageTests(unittest.TestCase):
    def test_round_trip_preserves_payload(self) -> None:
        original = WireMessage.create(
            "gesture.detected", gesture="grab", confidence=0.93
        )
        parsed = WireMessage.parse(original.to_json())

        self.assertEqual(parsed.type, "gesture.detected")
        self.assertEqual(parsed.payload["gesture"], "grab")
        self.assertEqual(parsed.payload["confidence"], 0.93)

    def test_rejects_unknown_protocol_version(self) -> None:
        raw = json.dumps({"version": 99, "id": "a", "type": "ping"})
        with self.assertRaises(ProtocolError):
            WireMessage.parse(raw)

    def test_reply_correlates_to_request(self) -> None:
        request = WireMessage.create("window.capture")
        response = reply(request, "window.captured", token="window-a")
        self.assertEqual(response.replyTo, request.id)


if __name__ == "__main__":
    unittest.main()
