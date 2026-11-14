from __future__ import annotations

from typing import Protocol


class KeyboardControlError(RuntimeError):
    pass


class KeyboardControlling(Protocol):
    def press_key(self, key: str) -> None: ...


class SimulatedKeyboardController:
    def __init__(self) -> None:
        self.pressed: list[str] = []

    def press_key(self, key: str) -> None:
        if key not in ("left", "right"):
            raise KeyboardControlError(f"Unsupported presentation key: {key}")
        self.pressed.append(key)


class MacOSKeyboardController:
    """Post presentation arrow keys to the currently focused macOS app."""

    KEY_CODES = {"left": 123, "right": 124}

    def __init__(self) -> None:
        try:
            import ApplicationServices as accessibility
            import Quartz
        except ImportError as exc:
            raise KeyboardControlError(
                "Install the macOS runtime dependencies with `make mac-setup`"
            ) from exc
        self.ax = accessibility
        self.quartz = Quartz

    def press_key(self, key: str) -> None:
        key_code = self.KEY_CODES.get(key)
        if key_code is None:
            raise KeyboardControlError(f"Unsupported presentation key: {key}")
        options = {self.ax.kAXTrustedCheckOptionPrompt: True}
        if not self.ax.AXIsProcessTrustedWithOptions(options):
            raise KeyboardControlError(
                "Grant Accessibility access to the app running the Mac runtime"
            )

        key_down = self.quartz.CGEventCreateKeyboardEvent(None, key_code, True)
        key_up = self.quartz.CGEventCreateKeyboardEvent(None, key_code, False)
        if key_down is None or key_up is None:
            raise KeyboardControlError("macOS could not create a keyboard event")
        self.quartz.CGEventPost(self.quartz.kCGHIDEventTap, key_down)
        self.quartz.CGEventPost(self.quartz.kCGHIDEventTap, key_up)
