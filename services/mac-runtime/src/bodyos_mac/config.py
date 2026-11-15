from __future__ import annotations

from dataclasses import dataclass
import os
from typing import Optional


@dataclass(frozen=True)
class RuntimeConfig:
    host: str = "0.0.0.0"
    port: int = 8765
    session_token: str = ""
    vexo_band_number: Optional[int] = None
    govee_lan_enabled: bool = False
    govee_device_ip: Optional[str] = None

    @classmethod
    def from_environment(cls, *, simulate: bool) -> "RuntimeConfig":
        raw_band = os.getenv("VEXO_BAND_NUMBER", "").strip()
        band_number = int(raw_band) if raw_band else None

        if not simulate and band_number is None:
            raise ValueError(
                "VEXO_BAND_NUMBER is required for real hardware. "
                "Use only the number printed on your team's band bag."
            )
        if band_number is not None and not 1 <= band_number <= 999:
            raise ValueError("VEXO_BAND_NUMBER must be between 1 and 999")

        return cls(
            host=os.getenv("BODYOS_WS_HOST", "0.0.0.0"),
            port=int(os.getenv("BODYOS_WS_PORT", "8765")),
            session_token=os.getenv("BODYOS_SESSION_TOKEN", ""),
            vexo_band_number=band_number,
            govee_lan_enabled=os.getenv("GOVEE_LAN", "").strip().lower()
            in ("1", "true", "yes", "on"),
            govee_device_ip=os.getenv("GOVEE_DEVICE_IP", "").strip() or None,
        )
