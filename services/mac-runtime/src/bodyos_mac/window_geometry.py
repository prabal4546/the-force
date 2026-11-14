"""Pure display/window geometry for Demo 1 window moving.

These helpers hold no macOS dependency so the Demo 1 placement logic can be
tested without Accessibility permission or real displays. All rectangles use the
same coordinate space macOS Accessibility and ``CGDisplayBounds`` use: a global
plane whose origin is the top-left of the main display, with y increasing
downward.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence


@dataclass(frozen=True)
class Rect:
    x: float
    y: float
    width: float
    height: float

    @property
    def max_x(self) -> float:
        return self.x + self.width

    @property
    def max_y(self) -> float:
        return self.y + self.height

    @property
    def center_x(self) -> float:
        return self.x + self.width / 2

    @property
    def center_y(self) -> float:
        return self.y + self.height / 2


@dataclass(frozen=True)
class Display:
    index: int
    bounds: Rect
    is_main: bool = False


def _overlap_area(a: Rect, b: Rect) -> float:
    dx = max(0.0, min(a.max_x, b.max_x) - max(a.x, b.x))
    dy = max(0.0, min(a.max_y, b.max_y) - max(a.y, b.y))
    return dx * dy


def _vertical_overlap(a: Rect, b: Rect) -> float:
    return max(0.0, min(a.max_y, b.max_y) - max(a.y, b.y))


def display_for_window(
    displays: Sequence[Display], window: Rect
) -> Optional[Display]:
    """Return the display the window sits on (greatest pixel overlap).

    If the window overlaps no display (e.g. parked off screen), fall back to the
    display whose center is nearest the window's center.
    """

    if not displays:
        return None

    best: Optional[Display] = None
    best_area = 0.0
    for display in displays:
        area = _overlap_area(display.bounds, window)
        if area > best_area:
            best_area = area
            best = display
    if best is not None:
        return best

    return min(
        displays,
        key=lambda d: (d.bounds.center_x - window.center_x) ** 2
        + (d.bounds.center_y - window.center_y) ** 2,
    )


def adjacent_display(
    displays: Sequence[Display], source: Display, direction: int
) -> Optional[Display]:
    """Return the nearest display to the left (-1) or right (1) of ``source``.

    Prefers a display that shares vertical range with the source, then the one
    nearest horizontally. Returns ``None`` when nothing lies in that direction.
    """

    if direction not in (-1, 1):
        raise ValueError("direction must be -1 (left) or 1 (right)")

    candidates = []
    for display in displays:
        if display.index == source.index:
            continue
        if direction < 0 and display.bounds.x < source.bounds.x:
            candidates.append(display)
        elif direction > 0 and display.bounds.x > source.bounds.x:
            candidates.append(display)

    if not candidates:
        return None

    def sort_key(display: Display) -> tuple[int, float]:
        shares_rows = _vertical_overlap(display.bounds, source.bounds) > 0
        return (0 if shares_rows else 1, abs(display.bounds.x - source.bounds.x))

    candidates.sort(key=sort_key)
    return candidates[0]


def target_frame(window: Rect, source: Display, target: Display) -> Rect:
    """Where the window should land on ``target``.

    Preserves the window's fractional position within the source display, shrinks
    it to fit if the target is smaller, then clamps so the whole window stays on
    the target display.
    """

    source_bounds = source.bounds
    target_bounds = target.bounds

    fraction_x = (
        (window.x - source_bounds.x) / source_bounds.width
        if source_bounds.width
        else 0.0
    )
    fraction_y = (
        (window.y - source_bounds.y) / source_bounds.height
        if source_bounds.height
        else 0.0
    )

    width = min(window.width, target_bounds.width)
    height = min(window.height, target_bounds.height)

    new_x = target_bounds.x + fraction_x * target_bounds.width
    new_y = target_bounds.y + fraction_y * target_bounds.height

    new_x = min(max(new_x, target_bounds.x), target_bounds.max_x - width)
    new_y = min(max(new_y, target_bounds.y), target_bounds.max_y - height)

    return Rect(new_x, new_y, width, height)
