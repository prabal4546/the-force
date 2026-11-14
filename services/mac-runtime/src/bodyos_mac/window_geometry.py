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
    """One display. ``bounds`` is the whole screen; ``visible`` is the part clear
    of the menu bar and Dock, when the system reported it."""

    index: int
    bounds: Rect
    is_main: bool = False
    visible: Optional[Rect] = None

    @property
    def usable(self) -> Rect:
        return self.visible if self.visible is not None else self.bounds


# Displays that touch share an edge exactly; this absorbs rounding only.
_EDGE_TOLERANCE = 1.0


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

    A display counts as being on that side only when it lies wholly beyond the
    source's edge, so one stacked above or below and merely offset sideways is
    not a neighbour. Prefers a display that shares vertical range with the
    source, then the one nearest horizontally. Returns ``None`` when nothing
    lies in that direction.
    """

    if direction not in (-1, 1):
        raise ValueError("direction must be -1 (left) or 1 (right)")

    candidates = []
    for display in displays:
        if display.index == source.index:
            continue
        if direction < 0 and display.bounds.max_x <= source.bounds.x + _EDGE_TOLERANCE:
            candidates.append(display)
        elif direction > 0 and display.bounds.x >= source.bounds.max_x - _EDGE_TOLERANCE:
            candidates.append(display)

    if not candidates:
        return None

    def sort_key(display: Display) -> tuple[int, float]:
        shares_rows = _vertical_overlap(display.bounds, source.bounds) > 0
        return (0 if shares_rows else 1, abs(display.bounds.x - source.bounds.x))

    candidates.sort(key=sort_key)
    return candidates[0]


def target_frame(
    window: Rect, source: Display, target: Display, size: Optional[Rect] = None
) -> Rect:
    """Where the window should land on ``target``.

    Works within each display's usable area (clear of the menu bar and Dock).
    Shrinks the window to fit if the target is smaller, and keeps it wholly on
    the target. Its position is carried over as a share of the room it has to
    move in (0 against the left or top edge, 1 against the right or bottom), so
    a window moved across and back returns to where it started.
    ``size`` asks for a width and height other than the
    window's current one, e.g. the size it had before an earlier move shrank it.
    """

    source_area = source.usable
    target_area = target.usable
    wanted = size if size is not None else window

    def share(offset: float, room: float) -> float:
        return min(max(offset / room, 0.0), 1.0) if room > 0 else 0.0

    share_x = share(window.x - source_area.x, source_area.width - window.width)
    share_y = share(window.y - source_area.y, source_area.height - window.height)

    width = min(wanted.width, target_area.width)
    height = min(wanted.height, target_area.height)

    return Rect(
        target_area.x + share_x * (target_area.width - width),
        target_area.y + share_y * (target_area.height - height),
        width,
        height,
    )
