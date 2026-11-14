"""Standalone Demo 1 window-move probe.

Moves the focused window to the display on its left or right, with no band,
iPhone, or glasses in the loop. This is step 1 of the Demo 1 plan: prove real
window movement on the hardware before wiring the gesture dispatcher.

    bodyos-move-window --direction right
    bodyos-move-window --direction left --simulate

Real moves need the pyobjc ``mac`` extra and Accessibility permission.
"""

from __future__ import annotations

import argparse

from .window_controller import (
    MacOSWindowMover,
    MoveResult,
    SimulatedWindowMover,
    WindowControlError,
    WindowMoving,
)

_DIRECTIONS = {"left": -1, "right": 1}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Move the focused window across displays")
    parser.add_argument(
        "--direction",
        required=True,
        choices=sorted(_DIRECTIONS),
        help="Which adjacent display to move the focused window to",
    )
    parser.add_argument(
        "--simulate",
        action="store_true",
        help="Use an in-memory two-display model instead of real macOS windows",
    )
    return parser


def _describe(result: MoveResult) -> str:
    where = ""
    if result.source_display is not None and result.target_display is not None:
        where = f" (display {result.source_display} -> {result.target_display})"
    title = f' "{result.title}"' if result.title else ""
    lines = [f"[{result.status}]{where} window{title}"]
    if result.final_frame is not None:
        frame = result.final_frame
        lines.append(
            f"  final frame: x={frame.x:.0f} y={frame.y:.0f} "
            f"w={frame.width:.0f} h={frame.height:.0f}"
        )
    if result.detail:
        lines.append(f"  {result.detail}")
    return "\n".join(lines)


def run(direction: int, *, simulate: bool) -> MoveResult:
    mover: WindowMoving
    mover = SimulatedWindowMover() if simulate else MacOSWindowMover()
    return mover.move_focused_window(direction)


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = run(_DIRECTIONS[args.direction], simulate=args.simulate)
    except WindowControlError as exc:
        print(f"[failed] {exc}")
        return 2
    print(_describe(result))
    # Exit non-zero when nothing moved, so scripts can branch on success.
    return 0 if result.moved else 1


if __name__ == "__main__":
    raise SystemExit(main())
