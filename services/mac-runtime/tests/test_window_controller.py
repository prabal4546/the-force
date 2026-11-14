import unittest

from bodyos_mac.window_controller import (
    SimulatedWindowController,
    WindowControlError,
)


class SimulatedWindowControllerTests(unittest.TestCase):
    def test_captured_window_can_move(self) -> None:
        controller = SimulatedWindowController()
        window = controller.capture_frontmost()
        controller.move_to_external_display(window.token)

    def test_unknown_token_is_rejected(self) -> None:
        controller = SimulatedWindowController()
        with self.assertRaises(WindowControlError):
            controller.move_to_external_display("missing")


if __name__ == "__main__":
    unittest.main()
