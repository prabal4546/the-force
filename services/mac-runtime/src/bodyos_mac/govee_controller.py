from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import asyncio
import json
import socket
import time
from typing import Any, Optional, Protocol


GOVEE_MULTICAST_HOST = "239.255.255.250"
GOVEE_SCAN_PORT = 4001
GOVEE_REPLY_PORT = 4002
GOVEE_CONTROL_PORT = 4003


class GoveeControlError(RuntimeError):
    pass


class GoveeControlling(Protocol):
    async def toggle(self) -> bool: ...
    async def adjust_brightness(self, delta: int) -> int: ...
    async def cycle_color(self) -> tuple[int, int, int]: ...


@dataclass(frozen=True)
class GoveeStatus:
    on: bool
    brightness: int
    color: tuple[int, int, int]


class GoveeLanController:
    """Local UDP controller for the Govee Table Lamp 2S (H8022)."""

    COLORS = (
        (255, 64, 64),
        (64, 255, 128),
        (64, 128, 255),
        (180, 64, 255),
        (255, 180, 32),
    )

    def __init__(
        self,
        device_ip: Optional[str] = None,
        *,
        sku: str = "H8022",
        timeout: float = 2.0,
        exchange: Optional[
            Callable[[str, dict[str, Any], bool], Optional[dict[str, Any]]]
        ] = None,
    ) -> None:
        self.device_ip = device_ip
        self.sku = sku
        self.timeout = timeout
        self._exchange_override = exchange
        # Python 3.9 requires a running event loop when an asyncio primitive is
        # created. The controller is assembled before asyncio.run(), so create
        # the lock lazily on the first band command.
        self._lock: Optional[asyncio.Lock] = None
        self._color_index = -1

    def _command_lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def toggle(self) -> bool:
        async with self._command_lock():
            status = await asyncio.to_thread(self._status)
            enabled = not status.on
            await asyncio.to_thread(self._command, "turn", {"value": int(enabled)})
            return enabled

    async def adjust_brightness(self, delta: int) -> int:
        async with self._command_lock():
            status = await asyncio.to_thread(self._status)
            brightness = max(1, min(100, status.brightness + delta))
            if not status.on:
                await asyncio.to_thread(self._command, "turn", {"value": 1})
            await asyncio.to_thread(
                self._command, "brightness", {"value": brightness}
            )
            return brightness

    async def cycle_color(self) -> tuple[int, int, int]:
        async with self._command_lock():
            self._color_index = (self._color_index + 1) % len(self.COLORS)
            red, green, blue = self.COLORS[self._color_index]
            await asyncio.to_thread(self._command, "turn", {"value": 1})
            await asyncio.to_thread(
                self._command,
                "colorwc",
                {
                    "color": {"r": red, "g": green, "b": blue},
                    "colorTemInKelvin": 0,
                },
            )
            return red, green, blue

    def _status(self) -> GoveeStatus:
        response = self._exchange("devStatus", {}, True)
        if response is None:
            raise GoveeControlError("Govee lamp did not return its status")
        data = response.get("msg", {}).get("data", {})
        color = data.get("color", {})
        try:
            return GoveeStatus(
                on=bool(data["onOff"]),
                brightness=int(data["brightness"]),
                color=(int(color["r"]), int(color["g"]), int(color["b"])),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise GoveeControlError("Govee returned an invalid status response") from exc

    def _command(self, command: str, data: dict[str, Any]) -> None:
        self._exchange(command, data, False)

    def _exchange(
        self,
        command: str,
        data: dict[str, Any],
        expects_reply: bool,
    ) -> Optional[dict[str, Any]]:
        if self._exchange_override is not None:
            return self._exchange_override(command, data, expects_reply)
        device_ip = self.device_ip or self._discover()
        self.device_ip = device_ip
        payload = json.dumps(
            {"msg": {"cmd": command, "data": data}}, separators=(",", ":")
        ).encode("utf-8")

        with self._reply_socket() as sock:
            sock.sendto(payload, (device_ip, GOVEE_CONTROL_PORT))
            if not expects_reply:
                return None
            deadline = time.monotonic() + self.timeout
            while time.monotonic() < deadline:
                try:
                    raw, _ = sock.recvfrom(65535)
                except socket.timeout:
                    continue
                response = self._parse(raw)
                if response.get("msg", {}).get("cmd") == command:
                    return response
        raise GoveeControlError(f"Govee lamp at {device_ip} did not answer {command}")

    def _discover(self) -> str:
        request = json.dumps(
            {"msg": {"cmd": "scan", "data": {"account_topic": "reserve"}}},
            separators=(",", ":"),
        ).encode("utf-8")
        with self._reply_socket(join_multicast=True) as sock:
            sock.sendto(request, (GOVEE_MULTICAST_HOST, GOVEE_SCAN_PORT))
            deadline = time.monotonic() + self.timeout
            while time.monotonic() < deadline:
                try:
                    raw, _ = sock.recvfrom(65535)
                except socket.timeout:
                    continue
                data = self._parse(raw).get("msg", {}).get("data", {})
                if data.get("sku") == self.sku and isinstance(data.get("ip"), str):
                    return data["ip"]
        raise GoveeControlError(
            f"Could not discover Govee {self.sku}. Enable LAN Control in the "
            "Govee app or set GOVEE_DEVICE_IP."
        )

    def _reply_socket(self, *, join_multicast: bool = False) -> socket.socket:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("", GOVEE_REPLY_PORT))
        sock.settimeout(0.2)
        if join_multicast:
            membership = socket.inet_aton(GOVEE_MULTICAST_HOST) + socket.inet_aton(
                "0.0.0.0"
            )
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, membership)
        return sock

    @staticmethod
    def _parse(raw: bytes) -> dict[str, Any]:
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise GoveeControlError("Govee returned invalid JSON") from exc
        if not isinstance(value, dict):
            raise GoveeControlError("Govee response must be a JSON object")
        return value
