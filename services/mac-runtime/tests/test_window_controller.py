import unittest

from bodyos_mac.window_controller import (
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


if __name__ == "__main__":
    unittest.main()
