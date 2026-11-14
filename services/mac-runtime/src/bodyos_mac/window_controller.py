from __future__ import annotations

from dataclasses import dataclass
from typing import Any, List, Optional, Protocol
from uuid import uuid4

from .window_geometry import (
    Display,
    Rect,
    adjacent_display,
    display_for_window,
    target_frame,
)


class WindowControlError(RuntimeError):
    pass


# --------------------------------------------------------------------------
# Legacy grab/throw interface used by the WebSocket iPhone route (server.py).
# Not part of the minimal Demo 1 swipe-to-move path, kept working as-is.
# --------------------------------------------------------------------------


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


# --------------------------------------------------------------------------
# Demo 1: move the focused window to the adjacent display (left / right swipe).
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class MoveResult:
    """Outcome of one Demo 1 move request.

    ``status`` is one of:
      * ``"completed"``  the focused window was moved and its new position was
        verified to sit on the target display,
      * ``"no_target"``  there is no display in the requested direction (nothing
        was moved),
      * ``"failed"``     a move was attempted but could not be verified, or the
        focused window / permission was unavailable (see ``detail``).
    """

    status: str
    direction: int
    title: Optional[str] = None
    source_display: Optional[int] = None
    target_display: Optional[int] = None
    requested_frame: Optional[Rect] = None
    final_frame: Optional[Rect] = None
    detail: Optional[str] = None

    @property
    def moved(self) -> bool:
        return self.status == "completed"


class WindowMoving(Protocol):
    def move_focused_window(self, direction: int) -> MoveResult: ...


def _validate_direction(direction: int) -> None:
    if direction not in (-1, 1):
        raise WindowControlError("direction must be -1 (left) or 1 (right)")


class SimulatedWindowMover:
    """In-memory mover for tests and ``--simulate`` runs.

    Starts with a focused window on the main display and a configurable set of
    displays, then applies the same geometry the real mover uses.
    """

    def __init__(
        self,
        displays: Optional[List[Display]] = None,
        window: Optional[Rect] = None,
        title: str = "Simulated window",
    ) -> None:
        self.displays = displays or [
            Display(index=0, bounds=Rect(0, 0, 1440, 900), is_main=True),
            Display(index=1, bounds=Rect(1440, 0, 1920, 1080)),
        ]
        self.window = window or Rect(200, 150, 800, 600)
        self.title = title

    def move_focused_window(self, direction: int) -> MoveResult:
        _validate_direction(direction)
        source = display_for_window(self.displays, self.window)
        if source is None:
            return MoveResult(
                status="failed", direction=direction, title=self.title,
                detail="No displays are available",
            )
        target = adjacent_display(self.displays, source, direction)
        if target is None:
            side = "left" if direction < 0 else "right"
            return MoveResult(
                status="no_target", direction=direction, title=self.title,
                source_display=source.index,
                detail=f"No display to the {side} of display {source.index}",
            )
        requested = target_frame(self.window, source, target)
        self.window = requested
        return MoveResult(
            status="completed", direction=direction, title=self.title,
            source_display=source.index, target_display=target.index,
            requested_frame=requested, final_frame=requested,
        )


class MacOSWindowMover:
    """Real Demo 1 mover backed by macOS Accessibility + Quartz (pyobjc).

    Reads the focused window's frame and the physical display arrangement, moves
    the window to the adjacent display using :mod:`window_geometry`, then re-reads
    the position to verify the move landed on the target display.

    Requires the ``mac`` extra (``pip install '.[mac]'``) and Accessibility
    permission (System Settings > Privacy & Security > Accessibility).
    """

    def __init__(self) -> None:
        self._ax: Optional["_AXBackend"] = None

    def move_focused_window(self, direction: int) -> MoveResult:
        _validate_direction(direction)
        try:
            ax = self._backend()
        except WindowControlError as exc:
            return MoveResult(status="failed", direction=direction, detail=str(exc))
        if not ax.is_process_trusted():
            return MoveResult(
                status="failed", direction=direction,
                detail=(
                    "Accessibility permission is not granted. Enable this app "
                    "under System Settings > Privacy & Security > Accessibility, "
                    "then try again."
                ),
            )

        try:
            window_ref, title, current = ax.focused_window()
        except WindowControlError as exc:
            return MoveResult(status="failed", direction=direction, detail=str(exc))

        displays = ax.displays()
        source = display_for_window(displays, current)
        if source is None:
            return MoveResult(
                status="failed", direction=direction, title=title,
                detail="Could not match the focused window to a display",
            )

        target = adjacent_display(displays, source, direction)
        if target is None:
            side = "left" if direction < 0 else "right"
            return MoveResult(
                status="no_target", direction=direction, title=title,
                source_display=source.index,
                detail=f"No display to the {side} of display {source.index}",
            )

        requested = target_frame(current, source, target)
        try:
            # Resize first so a window larger than the target display fits,
            # then position; re-read to verify the OS honored the request.
            ax.set_frame(window_ref, requested)
            final = ax.frame(window_ref)
        except WindowControlError as exc:
            return MoveResult(
                status="failed", direction=direction, title=title,
                source_display=source.index, target_display=target.index,
                requested_frame=requested, detail=str(exc),
            )

        landed_on = display_for_window(displays, final)
        verified = landed_on is not None and landed_on.index == target.index
        return MoveResult(
            status="completed" if verified else "failed",
            direction=direction, title=title,
            source_display=source.index, target_display=target.index,
            requested_frame=requested, final_frame=final,
            detail=None if verified else "Window did not settle on the target display",
        )

    def _backend(self) -> "_AXBackend":
        if self._ax is None:
            self._ax = _load_ax_backend()
        return self._ax


def _load_ax_backend() -> "_AXBackend":
    try:
        return _AXBackend()
    except ImportError as exc:  # pragma: no cover - requires the mac extra
        raise WindowControlError(
            "Real window moving needs the pyobjc 'mac' extra. "
            "Install it with: pip install '.[mac]'"
        ) from exc


class _AXBackend:  # pragma: no cover - exercised only on real macOS hardware
    """Thin wrapper over the Accessibility and Quartz C APIs.

    Isolated here so the placement logic above stays importable (and testable)
    without pyobjc. Every method raises :class:`WindowControlError` with an
    actionable message on failure.
    """

    def __init__(self) -> None:
        from AppKit import NSWorkspace  # noqa: F401  (import check)
        import ApplicationServices as AX
        import Quartz

        self._NSWorkspace = NSWorkspace
        self._AX = AX
        self._Quartz = Quartz

        # AXValue type constants moved names across pyobjc versions.
        self._point_type = getattr(AX, "kAXValueTypeCGPoint", None) or getattr(
            AX, "kAXValueCGPointType"
        )
        self._size_type = getattr(AX, "kAXValueTypeCGSize", None) or getattr(
            AX, "kAXValueCGSizeType"
        )

    def is_process_trusted(self) -> bool:
        return bool(self._AX.AXIsProcessTrusted())

    def _copy_attr(self, element, attribute):
        error, value = self._AX.AXUIElementCopyAttributeValue(
            element, attribute, None
        )
        if error != self._AX.kAXErrorSuccess:
            raise WindowControlError(
                f"Accessibility read failed for {attribute} (error {error})"
            )
        return value

    def focused_window(self):
        app = self._NSWorkspace.sharedWorkspace().frontmostApplication()
        if app is None:
            raise WindowControlError("No frontmost application is focused")
        pid = app.processIdentifier()
        app_element = self._AX.AXUIElementCreateApplication(pid)

        error, window = self._AX.AXUIElementCopyAttributeValue(
            app_element, self._AX.kAXFocusedWindowAttribute, None
        )
        if error != self._AX.kAXErrorSuccess or window is None:
            raise WindowControlError(
                f"{app.localizedName()} has no focused, movable window"
            )

        title = ""
        try:
            raw_title = self._copy_attr(window, self._AX.kAXTitleAttribute)
            title = str(raw_title) if raw_title is not None else ""
        except WindowControlError:
            title = app.localizedName() or ""

        return window, title, self.frame(window)

    def frame(self, window) -> Rect:
        position = self._copy_attr(window, self._AX.kAXPositionAttribute)
        size = self._copy_attr(window, self._AX.kAXSizeAttribute)
        ok_p, point = self._AX.AXValueGetValue(position, self._point_type, None)
        ok_s, extent = self._AX.AXValueGetValue(size, self._size_type, None)
        if not (ok_p and ok_s):
            raise WindowControlError("The focused window did not report a frame")
        return Rect(point.x, point.y, extent.width, extent.height)

    def set_frame(self, window, rect: Rect) -> None:
        from Quartz import CGPoint, CGSize

        size_value = self._AX.AXValueCreate(
            self._size_type, CGSize(rect.width, rect.height)
        )
        point_value = self._AX.AXValueCreate(
            self._point_type, CGPoint(rect.x, rect.y)
        )
        err_size = self._AX.AXUIElementSetAttributeValue(
            window, self._AX.kAXSizeAttribute, size_value
        )
        err_point = self._AX.AXUIElementSetAttributeValue(
            window, self._AX.kAXPositionAttribute, point_value
        )
        if err_point != self._AX.kAXErrorSuccess:
            raise WindowControlError(
                "The focused window refused to move (it may be full-screen or "
                "managed by the system)"
            )
        if err_size != self._AX.kAXErrorSuccess:
            # Position succeeded; a refused resize is non-fatal for the demo.
            pass

    def displays(self) -> List[Display]:
        max_displays = 16
        error, ids, count = self._Quartz.CGGetActiveDisplayList(
            max_displays, None, None
        )
        if error != 0 or not count:
            raise WindowControlError("No active displays were reported by Quartz")
        main_id = self._Quartz.CGMainDisplayID()
        displays: List[Display] = []
        for index, display_id in enumerate(ids[:count]):
            bounds = self._Quartz.CGDisplayBounds(display_id)
            displays.append(
                Display(
                    index=index,
                    bounds=Rect(
                        bounds.origin.x,
                        bounds.origin.y,
                        bounds.size.width,
                        bounds.size.height,
                    ),
                    is_main=(display_id == main_id),
                )
            )
        return displays
