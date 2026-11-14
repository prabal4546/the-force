from __future__ import annotations

from dataclasses import dataclass
import time
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


class MoveBackend(Protocol):
    """What a window mover needs from the system. Every method may raise
    :class:`WindowControlError` with a message fit to show the user."""

    def is_process_trusted(self) -> bool: ...
    def focused_window(self) -> tuple[Any, str, Rect]: ...
    def is_full_screen(self, window: Any) -> bool: ...
    def same_window(self, first: Any, second: Any) -> bool: ...
    def displays(self) -> List[Display]: ...
    def set_frame(self, window: Any, rect: Rect) -> None: ...
    def frame(self, window: Any) -> Rect: ...


def _validate_direction(direction: int) -> None:
    if direction not in (-1, 1):
        raise WindowControlError("direction must be -1 (left) or 1 (right)")


@dataclass(frozen=True)
class _Shrunk:
    """A window that a move made smaller, and the size it had before."""

    window: Any
    original: Rect
    shrunk: Rect


# Sizes within this many points count as the same (apps round their frames).
_SIZE_TOLERANCE = 2.0
_MAX_REMEMBERED_WINDOWS = 32


def _same_size(first: Rect, second: Rect) -> bool:
    return (
        abs(first.width - second.width) <= _SIZE_TOLERANCE
        and abs(first.height - second.height) <= _SIZE_TOLERANCE
    )


class BackendWindowMover:
    """Moves the focused window to the adjacent display through a backend.

    Reads the focused window's frame and the physical display arrangement, moves
    the window using :mod:`window_geometry`, then re-reads the position to verify
    the move landed on the target display. A window shrunk to fit a smaller
    display gets its earlier size back on a later move, unless it was resized by
    hand in between. Every failure comes back as a ``failed`` result; only an
    invalid direction raises.
    """

    def __init__(self, backend: Optional[MoveBackend] = None) -> None:
        self._ax = backend
        self._shrunk: List[_Shrunk] = []

    def move_focused_window(self, direction: int) -> MoveResult:
        _validate_direction(direction)
        try:
            return self._move(direction)
        except WindowControlError as exc:
            return MoveResult(status="failed", direction=direction, detail=str(exc))

    def _move(self, direction: int) -> MoveResult:
        ax = self._backend()
        if not ax.is_process_trusted():
            raise WindowControlError(
                "Accessibility permission is not granted. Enable this app "
                "under System Settings > Privacy & Security > Accessibility, "
                "then try again."
            )

        window_ref, title, current = ax.focused_window()
        if ax.is_full_screen(window_ref):
            return MoveResult(
                status="failed", direction=direction, title=title,
                detail="The focused window is full screen. Leave full screen to move it.",
            )

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

        wanted = self._size_before_shrinking(ax, window_ref, current)
        requested = target_frame(current, source, target, size=wanted)
        try:
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
        if verified and not _same_size(final, wanted):
            self._shrunk.append(_Shrunk(window_ref, original=wanted, shrunk=final))
            del self._shrunk[:-_MAX_REMEMBERED_WINDOWS]
        return MoveResult(
            status="completed" if verified else "failed",
            direction=direction, title=title,
            source_display=source.index, target_display=target.index,
            requested_frame=requested, final_frame=final,
            detail=None if verified else "Window did not settle on the target display",
        )

    def _size_before_shrinking(self, ax: MoveBackend, window_ref: Any, current: Rect) -> Rect:
        """The size to ask for: the one this window had before a move shrank it,
        if it still has the shrunk size. The remembered entry is used up."""

        for index, entry in enumerate(self._shrunk):
            if ax.same_window(entry.window, window_ref):
                del self._shrunk[index]
                return entry.original if _same_size(current, entry.shrunk) else current
        return current

    def _backend(self) -> MoveBackend:
        if self._ax is None:
            self._ax = self._load_backend()
        return self._ax

    def _load_backend(self) -> MoveBackend:
        raise WindowControlError("No window backend is configured")


class _SimulatedBackend:
    """An in-memory focused window on a set of displays."""

    def __init__(self, displays: List[Display], window: Rect, title: str) -> None:
        self.displays_list = displays
        self.window = window
        self.title = title

    def is_process_trusted(self) -> bool:
        return True

    def focused_window(self) -> tuple[Any, str, Rect]:
        return self, self.title, self.window

    def is_full_screen(self, window: Any) -> bool:
        return False

    def same_window(self, first: Any, second: Any) -> bool:
        return first is second

    def displays(self) -> List[Display]:
        if not self.displays_list:
            raise WindowControlError("No displays are available")
        return self.displays_list

    def set_frame(self, window: Any, rect: Rect) -> None:
        self.window = rect

    def frame(self, window: Any) -> Rect:
        return self.window


class SimulatedWindowMover(BackendWindowMover):
    """In-memory mover for tests and ``--simulate`` runs.

    Starts with a focused window on the main display and a configurable set of
    displays, and runs the same code path as the real mover.
    """

    def __init__(
        self,
        displays: Optional[List[Display]] = None,
        window: Optional[Rect] = None,
        title: str = "Simulated window",
    ) -> None:
        self._simulated = _SimulatedBackend(
            displays
            or [
                Display(index=0, bounds=Rect(0, 0, 1440, 900), is_main=True),
                Display(index=1, bounds=Rect(1440, 0, 1920, 1080)),
            ],
            window or Rect(200, 150, 800, 600),
            title,
        )
        super().__init__(self._simulated)

    @property
    def displays(self) -> List[Display]:
        return self._simulated.displays_list

    @property
    def window(self) -> Rect:
        return self._simulated.window

    @property
    def title(self) -> str:
        return self._simulated.title


class MacOSWindowMover(BackendWindowMover):
    """Real Demo 1 mover backed by macOS Accessibility + Quartz (pyobjc).

    Requires the ``mac`` extra (``pip install '.[mac]'``) and Accessibility
    permission (System Settings > Privacy & Security > Accessibility).
    """

    def _load_backend(self) -> MoveBackend:
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
        from AppKit import NSScreen
        import ApplicationServices as AX
        import CoreFoundation
        import Quartz

        self._NSScreen = NSScreen
        self._AX = AX
        self._CF = CoreFoundation
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

    def _focused_application(self):
        """The application whose window is in front right now, as an AX element
        and a name.

        Read from the window server's front-to-back window list on every call.
        ``NSWorkspace.frontmostApplication`` is only kept current by an AppKit
        event loop, which this process does not run: it would keep answering
        with whichever application was in front the first time.
        """
        options = (
            self._Quartz.kCGWindowListOptionOnScreenOnly
            | self._Quartz.kCGWindowListExcludeDesktopElements
        )
        windows = self._Quartz.CGWindowListCopyWindowInfo(
            options, self._Quartz.kCGNullWindowID
        )
        for window in windows or ():
            # Layer 0 holds ordinary application windows; the menu bar, Dock
            # and overlays sit on other layers.
            if window.get("kCGWindowLayer") == 0:
                pid = window.get("kCGWindowOwnerPID")
                name = window.get("kCGWindowOwnerName") or "The application in front"
                return self._AX.AXUIElementCreateApplication(pid), str(name)
        raise WindowControlError("No application window is open on screen")

    def focused_window(self):
        app_element, app_name = self._focused_application()

        error, window = self._AX.AXUIElementCopyAttributeValue(
            app_element, self._AX.kAXFocusedWindowAttribute, None
        )
        if error != self._AX.kAXErrorSuccess or window is None:
            raise WindowControlError(
                f"{app_name} has no focused, movable window"
            )

        # The desktop, and some panels, are focusable but cannot be placed.
        error, settable = self._AX.AXUIElementIsAttributeSettable(
            window, self._AX.kAXPositionAttribute, None
        )
        if error != self._AX.kAXErrorSuccess or not settable:
            raise WindowControlError(
                f"{app_name} has no movable window in focus. "
                "Click the window to move, then try again."
            )

        title = ""
        try:
            raw_title = self._copy_attr(window, self._AX.kAXTitleAttribute)
            title = str(raw_title) if raw_title is not None else ""
        except WindowControlError:
            title = app_name

        return window, title, self.frame(window)

    def is_full_screen(self, window) -> bool:
        error, value = self._AX.AXUIElementCopyAttributeValue(
            window, "AXFullScreen", None
        )
        return error == self._AX.kAXErrorSuccess and bool(value)

    def same_window(self, first, second) -> bool:
        return bool(self._CF.CFEqual(first, second))

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
        # Size, position, size: the first resize makes a window too big for the
        # target fit before it moves; the second lets a window grow back once it
        # is on a display large enough, where the first was capped by the
        # display it was still on. A refused resize is not fatal.
        self._AX.AXUIElementSetAttributeValue(
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
        # Just after the move the system may still cap the size by the display
        # the window came from, so ask again until it takes or stops changing.
        for _ in range(4):
            self._AX.AXUIElementSetAttributeValue(
                window, self._AX.kAXSizeAttribute, size_value
            )
            if _same_size(self.frame(window), rect):
                break
            time.sleep(0.05)

    def displays(self) -> List[Display]:
        max_displays = 16
        error, ids, count = self._Quartz.CGGetActiveDisplayList(
            max_displays, None, None
        )
        if error != 0 or not count:
            raise WindowControlError("No active displays were reported by Quartz")
        main_id = self._Quartz.CGMainDisplayID()
        main_height = self._Quartz.CGDisplayBounds(main_id).size.height
        visible = self._visible_areas(main_height)
        menu_bars = self._menu_bars()
        displays: List[Display] = []
        for index, display_id in enumerate(ids[:count]):
            raw = self._Quartz.CGDisplayBounds(display_id)
            bounds = Rect(raw.origin.x, raw.origin.y, raw.size.width, raw.size.height)
            # AppKit's screen list can lag behind a display change in a process
            # without an AppKit event loop; trust its visible area only when its
            # idea of the whole screen still matches Quartz.
            frame, area = visible.get(int(display_id), (None, None))
            if frame is None or not _same_rect(frame, bounds):
                area = bounds
            # The menu bar is read live from the window server as well: AppKit
            # does not always take it off a second display's visible area here.
            top = max([area.y] + [bar.max_y for bar in menu_bars if _tops(bar, bounds)])
            displays.append(
                Display(
                    index=index,
                    bounds=bounds,
                    is_main=(display_id == main_id),
                    visible=Rect(area.x, top, area.width, area.max_y - top),
                )
            )
        return displays

    def _menu_bars(self) -> List[Rect]:
        level = self._Quartz.CGWindowLevelForKey(self._Quartz.kCGMainMenuWindowLevelKey)
        windows = self._Quartz.CGWindowListCopyWindowInfo(
            self._Quartz.kCGWindowListOptionOnScreenOnly, self._Quartz.kCGNullWindowID
        )
        bars: List[Rect] = []
        for window in windows or ():
            box = window.get("kCGWindowBounds")
            if window.get("kCGWindowLayer") == level and box is not None:
                bars.append(Rect(box["X"], box["Y"], box["Width"], box["Height"]))
        return bars

    def _visible_areas(self, main_height: float) -> dict[int, tuple[Rect, Rect]]:
        """Each screen's whole frame and its area clear of the menu bar and Dock,
        by display id, converted from AppKit's bottom-left origin to the top-left
        one Accessibility and Quartz use."""

        def flipped(rect) -> Rect:
            return Rect(
                rect.origin.x,
                main_height - (rect.origin.y + rect.size.height),
                rect.size.width,
                rect.size.height,
            )

        areas: dict[int, tuple[Rect, Rect]] = {}
        try:
            for screen in self._NSScreen.screens():
                number = screen.deviceDescription().get("NSScreenNumber")
                if number is not None:
                    areas[int(number)] = (flipped(screen.frame()), flipped(screen.visibleFrame()))
        except Exception:
            return {}
        return areas


def _tops(bar: Rect, bounds: Rect) -> bool:
    """Whether ``bar`` is a strip running along the top edge of ``bounds``."""
    return (
        abs(bar.x - bounds.x) <= 1.0
        and abs(bar.y - bounds.y) <= 1.0
        and abs(bar.width - bounds.width) <= 1.0
        and bar.height < bounds.height / 4
    )


def _same_rect(first: Rect, second: Rect) -> bool:
    return all(
        abs(a - b) <= 1.0
        for a, b in (
            (first.x, second.x), (first.y, second.y),
            (first.width, second.width), (first.height, second.height),
        )
    )
