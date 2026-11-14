import unittest

from bodyos_mac.window_controller import (
    MacOSWindowController,
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


class FakeAccessibilityBackend:
    def __init__(self) -> None:
        self.window = object()
        self.frame = None

    def capture_frontmost(self):
        return self.window, "Demo window"

    def window_size(self, window):
        assert window is self.window
        return 1600.0, 1000.0

    def external_display_bounds(self):
        return 1920.0, 0.0, 1280.0, 720.0

    def set_window_frame(self, window, *, position, size):
        assert window is self.window
        self.frame = (position, size)


class MacOSWindowControllerTests(unittest.TestCase):
    def test_captured_window_reference_moves_to_external_display(self) -> None:
        backend = FakeAccessibilityBackend()
        controller = MacOSWindowController(backend)

        captured = controller.capture_frontmost()
        controller.move_to_external_display(captured.token)

        self.assertEqual(captured.title, "Demo window")
        self.assertEqual(backend.frame, ((1944.0, 24.0), (1232.0, 672.0)))

    def test_unknown_real_window_token_is_rejected(self) -> None:
        controller = MacOSWindowController(FakeAccessibilityBackend())
        with self.assertRaises(WindowControlError):
            controller.move_to_external_display("missing")


if __name__ == "__main__":
    unittest.main()
