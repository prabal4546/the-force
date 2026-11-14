"""Demo 1 gesture dispatcher: turn a band ``step`` into a real window move.

The HTTP API accepts a band event and returns ``202 accepted`` immediately. For
a ``step`` event it then hands the swipe direction to this dispatcher, which maps
it onto :meth:`WindowMoving.move_focused_window` and runs the (blocking) macOS
move off the event loop. Moves are serialized so two quick swipes never fight
over the same window.

The ``step`` contract already encodes direction as ``-1`` (left) / ``1`` (right),
which is exactly what the window mover expects, so the mapping is the identity.
Keeping it here, rather than in the HTTP layer, is deliberate: the device
contract defines a physical direction, and this module is the one place that
decides the Demo 1 window-management action it drives.
"""

from __future__ import annotations

import asyncio

from .window_controller import MoveResult, WindowMoving


class GestureDispatcher:
    def __init__(self, mover: WindowMoving) -> None:
        self._mover = mover
        self._lock = asyncio.Lock()

    async def move_for_step(self, direction: int) -> MoveResult:
        """Run one window move for a ``step`` swipe, serialized with others.

        ``direction`` must be ``-1`` (move left) or ``1`` (move right); the
        underlying mover rejects anything else.
        """

        if direction not in (-1, 1):
            raise ValueError("step direction must be -1 (left) or 1 (right)")
        async with self._lock:
            return await asyncio.to_thread(
                self._mover.move_focused_window, direction
            )
