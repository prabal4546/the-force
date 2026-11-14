from __future__ import annotations

import asyncio
from typing import Optional, Union

from websockets.asyncio.server import ServerConnection, serve

from .keyboard_controller import KeyboardControlError, KeyboardControlling
from .protocol import ProtocolError, WireMessage, reply
from .vexo_adapter import VexoInput
from .window_controller import WindowControlError, WindowControlling


class BodyOSServer:
    def __init__(
        self,
        window_controller: WindowControlling,
        vexo: VexoInput,
        *,
        host: str,
        port: int,
        keyboard: Optional[KeyboardControlling] = None,
    ) -> None:
        self.window_controller = window_controller
        self.vexo = vexo
        self.host = host
        self.port = port
        self.keyboard = keyboard
        self.clients: set[ServerConnection] = set()

    async def run(self) -> None:
        async with serve(self._handle_client, self.host, self.port):
            print(f"BodyOS Mac runtime listening on ws://{self.host}:{self.port}")
            gesture_task = asyncio.create_task(self._publish_gestures())
            try:
                await gesture_task
            finally:
                gesture_task.cancel()
                await self.vexo.close()

    async def _handle_client(self, socket: ServerConnection) -> None:
        self.clients.add(socket)
        await socket.send(WireMessage.create("hello", role="mac-runtime").to_json())
        try:
            async for raw in socket:
                response = await self._dispatch(raw, sender=socket)
                if response is not None:
                    await socket.send(response.to_json())
        finally:
            self.clients.discard(socket)

    async def _dispatch(
        self,
        raw: Union[str, bytes],
        *,
        sender: Optional[ServerConnection] = None,
    ) -> Optional[WireMessage]:
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        request: Optional[WireMessage] = None
        try:
            request = WireMessage.parse(raw)
            payload = request.payload or {}

            if request.type == "ping":
                return reply(request, "pong")

            if request.type == "window.capture":
                window = self.window_controller.capture_frontmost()
                return reply(
                    request,
                    "window.captured",
                    token=window.token,
                    title=window.title,
                )

            if request.type == "window.move":
                token = payload.get("token")
                if not isinstance(token, str) or not token:
                    raise ProtocolError("window.move requires a token")
                self.window_controller.move_to_external_display(token)
                return reply(request, "window.moved", token=token, success=True)

            if request.type == "vexo.led":
                color = payload.get("color")
                if not isinstance(color, str):
                    raise ProtocolError("vexo.led requires a color")
                await self.vexo.set_led(color)
                return None

            if request.type == "mac.key":
                key = payload.get("key")
                if key not in ("left", "right"):
                    raise ProtocolError("mac.key requires left or right")
                if self.keyboard is None:
                    raise KeyboardControlError("Mac keyboard control is not enabled")
                self.keyboard.press_key(key)
                return reply(request, "mac.key.pressed", key=key, success=True)

            if request.type == "gesture.detected":
                gesture = payload.get("gesture")
                confidence = payload.get("confidence")
                if gesture not in ("grab", "throw"):
                    raise ProtocolError("gesture.detected requires grab or throw")
                if not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
                    raise ProtocolError("gesture.detected requires confidence from 0 to 1")
                await self._broadcast(request.to_json(), exclude=sender)
                return None

            raise ProtocolError(f"Unsupported message type: {request.type}")
        except (KeyboardControlError, ProtocolError, WindowControlError) as exc:
            if request is not None:
                return reply(
                    request,
                    "error",
                    code="request-failed",
                    message=str(exc),
                )
            return WireMessage.create("error", code="request-failed", message=str(exc))

    async def _publish_gestures(self) -> None:
        async for gesture in self.vexo.gestures():
            message = WireMessage.create(
                "gesture.detected",
                gesture=gesture.name,
                confidence=gesture.confidence,
            ).to_json()
            await self._broadcast(message)

    async def _broadcast(
        self,
        message: str,
        *,
        exclude: Optional[ServerConnection] = None,
    ) -> None:
        stale: list[ServerConnection] = []
        for client in self.clients:
            if client is exclude:
                continue
            try:
                await client.send(message)
            except Exception:
                stale.append(client)
        for client in stale:
            self.clients.discard(client)
