from __future__ import annotations

import argparse
import asyncio
from collections import OrderedDict
from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
import secrets
from typing import Any, Literal, Optional
from uuid import uuid4
import warnings

from fastapi import APIRouter, Body, Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .band_contract import BandEvent
from .input_guard import DeviceInputGuard


class DeviceRegistration(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_id: str = Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")
    device_type: Literal["band", "glasses", "iphone", "mac"]
    hardware_status: Literal["connected", "disconnected", "unknown"] = "unknown"


class DeviceStatus(DeviceRegistration):
    status: Literal["registered"] = "registered"
    registered_at: datetime
    last_seen_at: datetime


class GestureInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    event_id: str = Field(min_length=1, max_length=128)
    device_id: str = Field(min_length=1, max_length=128)
    gesture: str = Field(min_length=1, max_length=64, pattern=r"^[a-z][a-z0-9_-]*$")
    timestamp: Optional[datetime] = None
    confidence: Optional[float] = Field(default=None, ge=0, le=1)

    @field_validator("timestamp")
    @classmethod
    def require_timezone(cls, value: Optional[datetime]) -> Optional[datetime]:
        if value is not None and value.utcoffset() is None:
            raise ValueError("timestamp must include a timezone, such as Z or +00:00")
        return value


class GestureStatus(BaseModel):
    status: Literal["accepted"] = "accepted"
    event_id: str
    device_id: str
    received_at: datetime


class PhotoStatus(BaseModel):
    status: Literal["received"] = "received"
    request_id: str
    device_id: str
    artifact_id: str
    content_type: str
    width: int
    height: int
    size_bytes: int
    photoUrl: str


def inspect_image(path: Path) -> tuple[str, int, int]:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                if image.format not in ("JPEG", "PNG"):
                    raise HTTPException(415, "Only JPEG and PNG images are supported")
                width, height = image.size
                if width * height > 40_000_000:
                    raise HTTPException(413, "Image dimensions exceed 40 megapixels")
                content_type = "image/jpeg" if image.format == "JPEG" else "image/png"
                image.verify()
            with Image.open(path) as image:
                image.load()
        return content_type, width, height
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombWarning, Image.DecompressionBombError):
        raise HTTPException(415, "The upload is not a valid JPEG or PNG image") from None


def create_app(
    *,
    upload_dir: Optional[Path] = None,
    session_token: Optional[str] = None,
    max_upload_bytes: int = 10 * 1024 * 1024,
) -> FastAPI:
    if max_upload_bytes <= 0:
        raise ValueError("max_upload_bytes must be positive")
    storage = Path(upload_dir) if upload_dir is not None else Path(os.getenv("BODYOS_UPLOAD_DIR", ".data/photos"))
    token = os.getenv("BODYOS_SESSION_TOKEN", "") if session_token is None else session_token
    application = FastAPI(
        title="BodyOS Device API",
        version="0.1.0",
        description="Register device adapters, receive gestures, and accept glasses photos. Registration does not establish a hardware Bluetooth connection.",
    )
    application.add_middleware(
        DeviceInputGuard, session_token=token, max_photo_body_bytes=max_upload_bytes + 64 * 1024,
    )
    devices: dict[str, DeviceStatus] = {}
    gestures: OrderedDict[tuple[str, str], dict[str, Any]] = OrderedDict()
    band_events: OrderedDict[tuple[str, str], dict[str, Any]] = OrderedDict()
    artifacts: dict[str, dict[str, Any]] = {}
    photo_requests: dict[tuple[str, str], str] = {}
    application.state.devices = devices
    application.state.gestures = gestures
    application.state.band_events = band_events
    application.state.artifacts = artifacts
    bearer = HTTPBearer(auto_error=False)

    @application.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, error: RequestValidationError) -> JSONResponse:
        details = [
            {key: item[key] for key in ("type", "loc", "msg")}
            for item in error.errors()
        ]
        return JSONResponse(status_code=422, content={"detail": details})

    async def authorize(credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer)) -> None:
        if token and (credentials is None or not secrets.compare_digest(credentials.credentials.encode(), token.encode())):
            raise HTTPException(401, "A valid demo session token is required", headers={"WWW-Authenticate": "Bearer"})

    def require_device(device_id: str, device_type: Optional[str] = None) -> DeviceStatus:
        device = devices.get(device_id)
        if device is None:
            raise HTTPException(404, "Device is not registered; call /v1/devices/connect first")
        if device_type is not None and device.device_type != device_type:
            raise HTTPException(409, f"This endpoint requires a registered {device_type} device")
        return device

    @application.get("/healthz")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    router = APIRouter(prefix="/v1", dependencies=[Depends(authorize)])

    @router.post("/devices/connect", response_model=DeviceStatus)
    async def connect_device(registration: DeviceRegistration) -> DeviceStatus:
        now = datetime.now(timezone.utc)
        previous = devices.get(registration.device_id)
        if previous is not None and previous.device_type != registration.device_type:
            raise HTTPException(409, "A registered device ID cannot change its device_type")
        device = DeviceStatus(
            **registration.model_dump(),
            registered_at=previous.registered_at if previous else now,
            last_seen_at=now,
        )
        devices[device.device_id] = device
        return device

    @router.get("/devices/{device_id}", response_model=DeviceStatus)
    async def device_status(device_id: str) -> DeviceStatus:
        return require_device(device_id)

    @router.post("/band/events", status_code=202, response_model=GestureStatus)
    async def receive_band_event(
        event: BandEvent = Body(..., discriminator="type"),
        device_id: str = Query(..., min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$"),
        idempotency_key: Optional[str] = Header(
            default=None, alias="Idempotency-Key", min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$",
        ),
    ) -> GestureStatus:
        device = require_device(device_id, "band")
        event_id = idempotency_key or uuid4().hex
        key = (device_id, event_id)
        payload = event.model_dump(mode="json")
        previous = band_events.get(key)
        if previous is not None:
            if previous["payload"] != payload:
                raise HTTPException(409, "Idempotency-Key was already used for a different band payload")
            device.last_seen_at = datetime.now(timezone.utc)
            return previous["response"]
        response = GestureStatus(event_id=event_id, device_id=device_id, received_at=datetime.now(timezone.utc))
        band_events[key] = {"payload": payload, "response": response}
        if len(band_events) > 1000:
            band_events.popitem(last=False)
        device.last_seen_at = response.received_at
        return response

    @router.post("/gestures", status_code=202, response_model=GestureStatus)
    async def receive_gesture(event: GestureInput) -> GestureStatus:
        device = require_device(event.device_id, "band")
        key = (event.device_id, event.event_id)
        payload = event.model_dump(mode="json")
        previous = gestures.get(key)
        if previous is not None:
            if previous["payload"] != payload:
                raise HTTPException(409, "event_id was already used for a different gesture payload")
            device.last_seen_at = datetime.now(timezone.utc)
            return previous["response"]
        response = GestureStatus(event_id=event.event_id, device_id=event.device_id, received_at=datetime.now(timezone.utc))
        gestures[key] = {"payload": payload, "response": response}
        if len(gestures) > 1000:
            gestures.popitem(last=False)
        device.last_seen_at = response.received_at
        return response

    @router.post("/glasses/photos", status_code=201, response_model=PhotoStatus)
    async def receive_photo(
        request: Request,
        photo: UploadFile = File(...),
        requestId: str = Form(..., min_length=1, max_length=128),
        device_id: str = Query(..., min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$"),
    ) -> PhotoStatus:
        require_device(device_id, "glasses")
        storage.mkdir(parents=True, exist_ok=True)
        artifact_id = uuid4().hex
        temporary = storage / f"{artifact_id}.tmp"
        size = 0
        digest = hashlib.sha256()
        try:
            with temporary.open("xb") as output:
                while chunk := await photo.read(64 * 1024):
                    size += len(chunk)
                    if size > max_upload_bytes:
                        raise HTTPException(413, f"Photo exceeds the {max_upload_bytes}-byte limit")
                    digest.update(chunk)
                    output.write(chunk)
            content_type, width, height = await asyncio.to_thread(inspect_image, temporary)
            key = (device_id, requestId)
            previous_id = photo_requests.get(key)
            if previous_id is not None:
                previous = artifacts[previous_id]
                if previous["digest"] != digest.hexdigest():
                    raise HTTPException(409, "requestId was already used for a different photo")
                devices[device_id].last_seen_at = datetime.now(timezone.utc)
                return previous["metadata"]
            extension = ".jpg" if content_type == "image/jpeg" else ".png"
            destination = storage / f"{artifact_id}{extension}"
            metadata = PhotoStatus(
                request_id=requestId,
                device_id=device_id,
                artifact_id=artifact_id,
                content_type=content_type,
                width=width,
                height=height,
                size_bytes=size,
                photoUrl=str(request.url_for("get_artifact", artifact_id=artifact_id)),
            )
            temporary.replace(destination)
            artifacts[artifact_id] = {"metadata": metadata, "path": destination, "digest": digest.hexdigest()}
            photo_requests[key] = artifact_id
            devices[device_id].last_seen_at = datetime.now(timezone.utc)
            return metadata
        finally:
            temporary.unlink(missing_ok=True)
            await photo.close()

    @router.get("/artifacts/{artifact_id}")
    async def get_artifact(artifact_id: str) -> FileResponse:
        artifact = artifacts.get(artifact_id)
        if artifact is None or not artifact["path"].is_file():
            raise HTTPException(404, "Photo artifact not found")
        return FileResponse(artifact["path"], media_type=artifact["metadata"].content_type)

    application.include_router(router)
    return application


app = create_app()


def main() -> None:
    import uvicorn

    parser = argparse.ArgumentParser(description="BodyOS device registration and input API")
    parser.add_argument("--host", default=os.getenv("BODYOS_API_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("BODYOS_API_PORT", "8000")))
    arguments = parser.parse_args()
    uvicorn.run("bodyos_mac.api:app", host=arguments.host, port=arguments.port)


if __name__ == "__main__":
    main()
