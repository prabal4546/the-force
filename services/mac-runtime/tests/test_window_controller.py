import unittest

from bodyos_mac.window_controller import (
    BackendWindowMover,
    MacOSWindowController,
    SimulatedWindowController,
    SimulatedWindowMover,
    WindowControlError,
)
from bodyos_mac.window_geometry import Display, Rect


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


class SimulatedWindowMoverTests(unittest.TestCase):
    def test_moves_right_to_adjacent_display(self) -> None:
        mover = SimulatedWindowMover()
        result = mover.move_focused_window(1)
        self.assertEqual(result.status, "completed")
        self.assertTrue(result.moved)
        self.assertEqual(result.source_display, 0)
        self.assertEqual(result.target_display, 1)
        # The window now sits on display 1.
        self.assertGreaterEqual(mover.window.x, 1440)

    def test_reverse_swipe_moves_back(self) -> None:
        mover = SimulatedWindowMover()
        mover.move_focused_window(1)
        result = mover.move_focused_window(-1)
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.target_display, 0)
        self.assertLess(mover.window.x, 1440)

    def test_no_display_in_direction_is_reported(self) -> None:
        mover = SimulatedWindowMover()
        result = mover.move_focused_window(-1)  # nothing left of the main display
        self.assertEqual(result.status, "no_target")
        self.assertFalse(result.moved)
        # Window did not move.
        self.assertEqual(mover.window, Rect(200, 150, 800, 600))

    def test_single_display_has_no_target(self) -> None:
        mover = SimulatedWindowMover(
            displays=[Display(index=0, bounds=Rect(0, 0, 1440, 900), is_main=True)]
        )
        self.assertEqual(mover.move_focused_window(1).status, "no_target")

    def test_invalid_direction_rejected(self) -> None:
        mover = SimulatedWindowMover()
        with self.assertRaises(WindowControlError):
            mover.move_focused_window(0)

    def test_shrunk_window_gets_its_size_back(self) -> None:
        mover = SimulatedWindowMover(
            displays=[
                Display(index=0, bounds=Rect(0, 0, 2000, 2000), is_main=True),
                Display(index=1, bounds=Rect(2000, 0, 800, 600)),
            ],
            window=Rect(100, 100, 1500, 1200),
        )
        mover.move_focused_window(1)
        self.assertEqual((mover.window.width, mover.window.height), (800, 600))
        mover.move_focused_window(-1)
        self.assertEqual((mover.window.width, mover.window.height), (1500, 1200))

    def test_window_resized_by_hand_keeps_its_new_size(self) -> None:
        mover = SimulatedWindowMover(
            displays=[
                Display(index=0, bounds=Rect(0, 0, 2000, 2000), is_main=True),
                Display(index=1, bounds=Rect(2000, 0, 800, 600)),
            ],
            window=Rect(100, 100, 1500, 1200),
        )
        mover.move_focused_window(1)
        mover._simulated.window = Rect(2100, 50, 400, 300)
        mover.move_focused_window(-1)
        self.assertEqual((mover.window.width, mover.window.height), (400, 300))


class FakeMoveBackend:
    def __init__(self, *, trusted=True, full_screen=False, displays_error=None) -> None:
        self.trusted = trusted
        self.full_screen = full_screen
        self.displays_error = displays_error
        self.window = Rect(100, 100, 400, 300)

    def is_process_trusted(self):
        return self.trusted

    def focused_window(self):
        return self, "Fake window", self.window

    def is_full_screen(self, window):
        return self.full_screen

    def same_window(self, first, second):
        return first is second

    def displays(self):
        if self.displays_error:
            raise WindowControlError(self.displays_error)
        return [
            Display(index=0, bounds=Rect(0, 0, 1440, 900), is_main=True),
            Display(index=1, bounds=Rect(1440, 0, 1920, 1080)),
        ]

    def set_frame(self, window, rect):
        self.window = rect

    def frame(self, window):
        return self.window


class BackendWindowMoverTests(unittest.TestCase):
    def test_missing_permission_is_a_failed_result(self) -> None:
        result = BackendWindowMover(FakeMoveBackend(trusted=False)).move_focused_window(1)
        self.assertEqual(result.status, "failed")
        self.assertIn("Accessibility permission", result.detail)

    def test_full_screen_window_is_not_moved(self) -> None:
        backend = FakeMoveBackend(full_screen=True)
        result = BackendWindowMover(backend).move_focused_window(1)
        self.assertEqual(result.status, "failed")
        self.assertIn("full screen", result.detail)
        self.assertEqual(backend.window, Rect(100, 100, 400, 300))

    def test_display_lookup_error_is_a_failed_result(self) -> None:
        backend = FakeMoveBackend(displays_error="No active displays were reported by Quartz")
        result = BackendWindowMover(backend).move_focused_window(1)
        self.assertEqual(result.status, "failed")
        self.assertIn("No active displays", result.detail)


if __name__ == "__main__":
    unittest.main()
