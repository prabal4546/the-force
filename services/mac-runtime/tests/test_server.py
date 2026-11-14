import asyncio
import json
import unittest
from unittest.mock import AsyncMock

from bodyos_mac.protocol import WireMessage
from bodyos_mac.server import BodyOSServer
from bodyos_mac.vexo_adapter import SimulatedVexoInput
from bodyos_mac.window_controller import SimulatedWindowController


class ServerGestureRelayTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = BodyOSServer(
            SimulatedWindowController(),
            SimulatedVexoInput(),
            host="127.0.0.1",
            port=8765,
        )

    def test_dashboard_gesture_is_relayed_to_other_clients(self) -> None:
        dashboard = AsyncMock()
        iphone = AsyncMock()
        self.server.clients = {dashboard, iphone}
        message = WireMessage.create(
            "gesture.detected", gesture="grab", confidence=1.0
        )

        response = asyncio.run(
            self.server._dispatch(message.to_json(), sender=dashboard)
        )

        self.assertIsNone(response)
        dashboard.send.assert_not_called()
        iphone.send.assert_awaited_once()
        relayed = json.loads(iphone.send.await_args.args[0])
        self.assertEqual(relayed["id"], message.id)
        self.assertEqual(relayed["gesture"], "grab")

    def test_invalid_dashboard_gesture_is_rejected(self) -> None:
        dashboard = AsyncMock()
        iphone = AsyncMock()
        self.server.clients = {dashboard, iphone}
        message = WireMessage.create(
            "gesture.detected", gesture="spin", confidence=1.0
        )

        response = asyncio.run(
            self.server._dispatch(message.to_json(), sender=dashboard)
        )

        self.assertIsNotNone(response)
        self.assertEqual(response.type, "error")
        iphone.send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
