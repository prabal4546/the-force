from __future__ import annotations

from dataclasses import asdict, dataclass
import json
from typing import Any, Optional
from uuid import uuid4


PROTOCOL_VERSION = 1


class ProtocolError(ValueError):
    pass


@dataclass
class WireMessage:
    type: str
    id: str
    version: int = PROTOCOL_VERSION
    replyTo: Optional[str] = None
    payload: Optional[dict[str, Any]] = None

    @classmethod
    def create(cls, message_type: str, **payload: Any) -> "WireMessage":
        return cls(type=message_type, id=str(uuid4()), payload=payload or None)

    @classmethod
    def parse(cls, raw: str) -> "WireMessage":
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ProtocolError("Message is not valid JSON") from exc

        if not isinstance(data, dict):
            raise ProtocolError("Message must be a JSON object")
        if data.get("version") != PROTOCOL_VERSION:
            raise ProtocolError("Unsupported protocol version")
        if not isinstance(data.get("id"), str) or not data["id"]:
            raise ProtocolError("Message id is required")
        if not isinstance(data.get("type"), str) or not data["type"]:
            raise ProtocolError("Message type is required")

        reserved = {"version", "id", "type", "replyTo"}
        payload = {key: value for key, value in data.items() if key not in reserved}
        return cls(
            version=data["version"],
            id=data["id"],
            type=data["type"],
            replyTo=data.get("replyTo"),
            payload=payload or None,
        )

    def to_dict(self) -> dict[str, Any]:
        data = {key: value for key, value in asdict(self).items() if value is not None}
        payload = data.pop("payload", None)
        if payload:
            data.update(payload)
        return data

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), separators=(",", ":"))


def reply(request: WireMessage, message_type: str, **payload: Any) -> WireMessage:
    message = WireMessage.create(message_type, **payload)
    message.replyTo = request.id
    return message
