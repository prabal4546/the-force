import asyncio
import unittest

from bodyos_mac.dispatcher import GestureDispatcher
from bodyos_mac.window_controller import SimulatedWindowMover, WindowMoving


class RecordingMover:
    """A mover that records how many times and with what it was called."""

    def __init__(self, inner: WindowMoving) -> None:
        self._inner = inner
        self.calls: list[int] = []

    def move_focused_window(self, direction: int):
        self.calls.append(direction)
        return self._inner.move_focused_window(direction)


class GestureDispatcherTests(unittest.TestCase):
    def test_step_right_triggers_a_move(self) -> None:
        mover = SimulatedWindowMover()
        dispatcher = GestureDispatcher(mover)
        result = asyncio.run(dispatcher.move_for_step(1))
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.target_display, 1)

    def test_step_left_with_no_display_reports_no_target(self) -> None:
        dispatcher = GestureDispatcher(SimulatedWindowMover())
        result = asyncio.run(dispatcher.move_for_step(-1))
        self.assertEqual(result.status, "no_target")

    def test_moves_run_one_at_a_time(self) -> None:
        # Two concurrent dispatches must not overlap on the shared window state.
        mover = RecordingMover(SimulatedWindowMover())
        dispatcher = GestureDispatcher(mover)

        async def drive() -> None:
            await asyncio.gather(
                dispatcher.move_for_step(1),
                dispatcher.move_for_step(-1),
            )

        asyncio.run(drive())
        self.assertEqual(len(mover.calls), 2)

    def test_invalid_direction_is_rejected(self) -> None:
        dispatcher = GestureDispatcher(SimulatedWindowMover())
        with self.assertRaises(ValueError):
            asyncio.run(dispatcher.move_for_step(0))


if __name__ == "__main__":
    unittest.main()
