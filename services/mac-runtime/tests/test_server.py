import asyncio
import json
import unittest
from unittest.mock import AsyncMock

from bodyos_mac.keyboard_controller import SimulatedKeyboardController
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


class ServerKeyboardControlTests(unittest.TestCase):
    def setUp(self) -> None:
        self.keyboard = SimulatedKeyboardController()
        self.server = BodyOSServer(
            SimulatedWindowController(),
            SimulatedVexoInput(),
            host="127.0.0.1",
            port=8765,
            keyboard=self.keyboard,
        )

    def test_presentation_arrow_is_pressed_and_acknowledged(self) -> None:
        request = WireMessage.create("mac.key", key="right")

        response = asyncio.run(self.server._dispatch(request.to_json()))

        self.assertEqual(self.keyboard.pressed, ["right"])
        self.assertIsNotNone(response)
        self.assertEqual(response.type, "mac.key.pressed")
        self.assertEqual(response.replyTo, request.id)

    def test_other_keys_are_rejected(self) -> None:
        request = WireMessage.create("mac.key", key="delete")

        response = asyncio.run(self.server._dispatch(request.to_json()))

        self.assertEqual(self.keyboard.pressed, [])
        self.assertIsNotNone(response)
        self.assertEqual(response.type, "error")


if __name__ == "__main__":
    unittest.main()
