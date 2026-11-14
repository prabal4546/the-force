import secrets

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class DeviceInputGuard:
    def __init__(self, app: ASGIApp, session_token: str, max_photo_body_bytes: int):
        self.app = app
        self.session_token = session_token
        self.max_photo_body_bytes = max_photo_body_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/v1/"):
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        scheme, _, credential = headers.get("authorization", "").partition(" ")
        if self.session_token and (
            scheme.lower() != "bearer"
            or not secrets.compare_digest(credential.encode(), self.session_token.encode())
        ):
            await JSONResponse(
                {"detail": "A valid demo session token is required"}, status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )(scope, receive, send)
            return
        if scope["method"] != "POST" or scope["path"] != "/v1/glasses/photos":
            await self.app(scope, receive, send)
            return
        declared_length = headers.get("content-length")
        if declared_length is not None:
            try:
                length = int(declared_length)
                if length < 0:
                    raise ValueError
            except ValueError:
                await JSONResponse({"detail": "Invalid Content-Length"}, status_code=400)(scope, receive, send)
                return
            if length > self.max_photo_body_bytes:
                await self.reject_size(scope, receive, send)
                return
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            if len(body) + len(chunk) > self.max_photo_body_bytes:
                await self.reject_size(scope, receive, send)
                return
            body.extend(chunk)
            if not message.get("more_body", False):
                break
        delivered = False

        async def replay() -> Message:
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)

    async def reject_size(self, scope: Scope, receive: Receive, send: Send) -> None:
        await JSONResponse(
            {"detail": f"Photo request body exceeds the {self.max_photo_body_bytes}-byte limit"},
            status_code=413,
        )(scope, receive, send)
