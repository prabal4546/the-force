from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from uuid import uuid4


class WindowControlError(RuntimeError):
    pass


@dataclass(frozen=True)
class CapturedWindow:
    token: str
    title: str


class WindowControlling(Protocol):
    def capture_frontmost(self) -> CapturedWindow: ...
    def move_to_external_display(self, token: str) -> None: ...


class SimulatedWindowController:
    def __init__(self) -> None:
        self._windows: dict[str, CapturedWindow] = {}

    def capture_frontmost(self) -> CapturedWindow:
        window = CapturedWindow(token=str(uuid4()), title="Mock frontmost window")
        self._windows[window.token] = window
        return window

    def move_to_external_display(self, token: str) -> None:
        if token not in self._windows:
            raise WindowControlError("Captured window token is unknown or expired")


class MacOSWindowController:
    """Accessibility-backed implementation owned by the Mac-window teammate."""

    def capture_frontmost(self) -> CapturedWindow:
        raise WindowControlError(
            "Real AX window capture is not implemented yet; run with --simulate"
        )

    def move_to_external_display(self, token: str) -> None:
        raise WindowControlError(
            "Real AX window movement is not implemented yet; run with --simulate"
        )
