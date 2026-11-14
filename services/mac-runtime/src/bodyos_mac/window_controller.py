from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol
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


class AccessibilityBackend(Protocol):
    def capture_frontmost(self) -> tuple[Any, str]: ...
    def window_size(self, window: Any) -> tuple[float, float]: ...
    def external_display_bounds(self) -> tuple[float, float, float, float]: ...
    def set_window_frame(
        self,
        window: Any,
        *,
        position: tuple[float, float],
        size: tuple[float, float],
    ) -> None: ...


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
    """Capture a stable AX window reference and move it to a second display."""

    def __init__(self, backend: AccessibilityBackend | None = None) -> None:
        self._backend = backend or PyObjCAccessibilityBackend()
        self._windows: dict[str, Any] = {}

    def capture_frontmost(self) -> CapturedWindow:
        window, title = self._backend.capture_frontmost()
        token = str(uuid4())
        self._windows[token] = window
        return CapturedWindow(token=token, title=title)

    def move_to_external_display(self, token: str) -> None:
        window = self._windows.get(token)
        if window is None:
            raise WindowControlError("Captured window token is unknown or expired")

        x, y, display_width, display_height = self._backend.external_display_bounds()
        width, height = self._backend.window_size(window)
        margin = 24.0
        width = min(width, max(320.0, display_width - margin * 2))
        height = min(height, max(240.0, display_height - margin * 2))
        position = (
            x + max(margin, (display_width - width) / 2),
            y + max(margin, (display_height - height) / 2),
        )
        self._backend.set_window_frame(
            window,
            position=position,
            size=(width, height),
        )


class PyObjCAccessibilityBackend:
    """Thin lazy wrapper around macOS Accessibility and display APIs."""

    def __init__(self) -> None:
        try:
            import ApplicationServices as accessibility
            import Quartz
            from AppKit import NSWorkspace
        except ImportError as exc:
            raise WindowControlError(
                "Install the macOS runtime dependencies with `make mac-setup`"
            ) from exc
        self.ax = accessibility
        self.quartz = Quartz
        self.workspace = NSWorkspace.sharedWorkspace()

    def _require_accessibility(self) -> None:
        options = {self.ax.kAXTrustedCheckOptionPrompt: True}
        if not self.ax.AXIsProcessTrustedWithOptions(options):
            raise WindowControlError(
                "Grant Accessibility access to Terminal (or the app running the runtime) "
                "in System Settings > Privacy & Security > Accessibility, then restart it"
            )

    def _attribute(self, element: Any, attribute: str, label: str) -> Any:
        error, value = self.ax.AXUIElementCopyAttributeValue(
            element, attribute, None
        )
        if error != self.ax.kAXErrorSuccess or value is None:
            raise WindowControlError(f"Could not read the window {label} (AX error {error})")
        return value

    def capture_frontmost(self) -> tuple[Any, str]:
        self._require_accessibility()
        application = self.workspace.frontmostApplication()
        if application is None:
            raise WindowControlError("No frontmost Mac application was found")
        app_element = self.ax.AXUIElementCreateApplication(
            application.processIdentifier()
        )
        window = self._attribute(
            app_element,
            self.ax.kAXFocusedWindowAttribute,
            "focused window",
        )
        error, title = self.ax.AXUIElementCopyAttributeValue(
            window, self.ax.kAXTitleAttribute, None
        )
        if error != self.ax.kAXErrorSuccess or not title:
            title = application.localizedName() or "Frontmost window"
        return window, str(title)

    def window_size(self, window: Any) -> tuple[float, float]:
        value = self._attribute(window, self.ax.kAXSizeAttribute, "size")
        success, size = self.ax.AXValueGetValue(
            value, self.ax.kAXValueCGSizeType, None
        )
        if not success:
            raise WindowControlError("Could not decode the captured window size")
        return float(size.width), float(size.height)

    def external_display_bounds(self) -> tuple[float, float, float, float]:
        error, display_ids, count = self.quartz.CGGetActiveDisplayList(
            16, None, None
        )
        if error != self.quartz.kCGErrorSuccess:
            raise WindowControlError(f"Could not list displays (CG error {error})")
        main_display = self.quartz.CGMainDisplayID()
        external = [display for display in display_ids[:count] if display != main_display]
        if not external:
            raise WindowControlError(
                "No external display was found; use extended desktop instead of mirroring"
            )
        bounds = self.quartz.CGDisplayBounds(external[0])
        return (
            float(bounds.origin.x),
            float(bounds.origin.y),
            float(bounds.size.width),
            float(bounds.size.height),
        )

    def set_window_frame(
        self,
        window: Any,
        *,
        position: tuple[float, float],
        size: tuple[float, float],
    ) -> None:
        point = self.quartz.CGPoint(*position)
        dimensions = self.quartz.CGSize(*size)
        position_value = self.ax.AXValueCreate(
            self.ax.kAXValueCGPointType, point
        )
        size_value = self.ax.AXValueCreate(
            self.ax.kAXValueCGSizeType, dimensions
        )
        position_error = self.ax.AXUIElementSetAttributeValue(
            window, self.ax.kAXPositionAttribute, position_value
        )
        size_error = self.ax.AXUIElementSetAttributeValue(
            window, self.ax.kAXSizeAttribute, size_value
        )
        if position_error != self.ax.kAXErrorSuccess:
            raise WindowControlError(
                f"The captured window could not be moved (AX error {position_error})"
            )
        if size_error not in (
            self.ax.kAXErrorSuccess,
            self.ax.kAXErrorAttributeUnsupported,
        ):
            raise WindowControlError(
                f"The captured window could not be resized (AX error {size_error})"
            )
