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

    def test_mentra_target_is_relayed_and_acknowledged(self) -> None:
        miniapp = AsyncMock()
        iphone = AsyncMock()
        self.server.clients = {miniapp, iphone}
        message = WireMessage.create(
            "target.detected", target="mac", confidence=1.0
        )

        response = asyncio.run(
            self.server._dispatch(message.to_json(), sender=miniapp)
        )

        self.assertIsNotNone(response)
        self.assertEqual(response.type, "target.detected")
        self.assertEqual(response.replyTo, message.id)
        self.assertEqual(response.payload, {"target": "mac", "locked": True})
        iphone.send.assert_awaited_once_with(message.to_json())

    def test_unknown_mentra_target_is_rejected(self) -> None:
        message = WireMessage.create("target.detected", target="lamp")

        response = asyncio.run(self.server._dispatch(message.to_json()))

        self.assertIsNotNone(response)
        self.assertEqual(response.type, "error")

    def test_mentra_target_is_retained_for_late_clients(self) -> None:
        request = WireMessage.create("target.detected", target="mac")

        asyncio.run(self.server._dispatch(request.to_json()))

        self.assertEqual(self.server.active_target, "mac")


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


class FakeGoveeController:
    def __init__(self) -> None:
        self.actions = []

    async def toggle(self) -> bool:
        self.actions.append(("toggle",))
        return True

    async def adjust_brightness(self, delta: int) -> int:
        self.actions.append(("brightness", delta))
        return 60

    async def cycle_color(self) -> tuple[int, int, int]:
        self.actions.append(("color",))
        return 255, 64, 64


class ServerGoveeControlTests(unittest.TestCase):
    def setUp(self) -> None:
        self.govee = FakeGoveeController()
        self.server = BodyOSServer(
            SimulatedWindowController(),
            SimulatedVexoInput(),
            host="127.0.0.1",
            port=8765,
            govee=self.govee,
        )

    def test_single_tap_toggles_lamp(self) -> None:
        request = WireMessage.create(
            "gesture.detected", gesture="grab", confidence=1.0
        )

        response = asyncio.run(self.server._dispatch(request.to_json()))

        self.assertEqual(self.govee.actions, [("toggle",)])
        self.assertEqual(response.type, "govee.controlled")
        self.assertEqual(response.payload["action"], "power")

    def test_double_tap_cycles_color(self) -> None:
        request = WireMessage.create(
            "gesture.detected", gesture="throw", confidence=1.0
        )

        response = asyncio.run(self.server._dispatch(request.to_json()))

        self.assertEqual(self.govee.actions, [("color",)])
        self.assertEqual(response.payload["action"], "color")

    def test_wrist_step_changes_brightness(self) -> None:
        request = WireMessage.create("mac.key", key="left")

        response = asyncio.run(self.server._dispatch(request.to_json()))

        self.assertEqual(self.govee.actions, [("brightness", -10)])
        self.assertEqual(response.payload["value"], 60)


if __name__ == "__main__":
    unittest.main()
