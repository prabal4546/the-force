import asyncio
import unittest

from bodyos_mac.govee_controller import GoveeLanController


class GoveeLanControllerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.commands = []
        self.status = {
            "msg": {
                "cmd": "devStatus",
                "data": {
                    "onOff": 1,
                    "brightness": 50,
                    "color": {"r": 255, "g": 255, "b": 255},
                    "colorTemInKelvin": 4000,
                },
            }
        }

        def exchange(command, data, expects_reply):
            self.commands.append((command, data, expects_reply))
            return self.status if expects_reply else None

        self.controller = GoveeLanController(exchange=exchange)

    def test_toggle_uses_current_lamp_state(self) -> None:
        enabled = asyncio.run(self.controller.toggle())

        self.assertFalse(enabled)
        self.assertEqual(self.commands[-1], ("turn", {"value": 0}, False))

    def test_brightness_moves_by_delta(self) -> None:
        brightness = asyncio.run(self.controller.adjust_brightness(10))

        self.assertEqual(brightness, 60)
        self.assertEqual(
            self.commands[-1], ("brightness", {"value": 60}, False)
        )

    def test_cycle_color_turns_on_then_sets_rgb(self) -> None:
        color = asyncio.run(self.controller.cycle_color())

        self.assertEqual(color, (255, 64, 64))
        self.assertEqual(self.commands[-2], ("turn", {"value": 1}, False))
        self.assertEqual(self.commands[-1][0], "colorwc")
        self.assertEqual(
            self.commands[-1][1]["color"], {"r": 255, "g": 64, "b": 64}
        )


if __name__ == "__main__":
    unittest.main()
