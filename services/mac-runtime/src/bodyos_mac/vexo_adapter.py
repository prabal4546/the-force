from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
import asyncio
from typing import Protocol


@dataclass(frozen=True)
class Gesture:
    name: str
    confidence: float


class VexoInput(Protocol):
    async def gestures(self) -> AsyncIterator[Gesture]: ...
    async def set_led(self, color: str) -> None: ...
    async def close(self) -> None: ...


class SimulatedVexoInput:
    async def gestures(self) -> AsyncIterator[Gesture]:
        while True:
            raw = await asyncio.to_thread(
                input, "Vexo simulator: [g]rab, [t]hrow, [q]uit > "
            )
            value = raw.strip().lower()
            if value == "q":
                return
            if value == "g":
                yield Gesture("grab", 1.0)
            elif value == "t":
                yield Gesture("throw", 1.0)

    async def set_led(self, color: str) -> None:
        print(f"[simulated Vexo LED] {color}")

    async def close(self) -> None:
        return None


class RealVexoInput:
    """Adapter boundary for the Vexo owner.

    Implement this with vendor/vexo-open-kit. The constructor accepts the
    already-validated team band number so there is one source of truth.
    """

    def __init__(self, band_number: int) -> None:
        self.band_number = band_number

    async def gestures(self) -> AsyncIterator[Gesture]:
        raise RuntimeError(
            "Real Vexo gesture input is not implemented. "
            "Use the vendored kit and connect only to the configured band number."
        )
        yield  # pragma: no cover

    async def set_led(self, color: str) -> None:
        raise RuntimeError("Real Vexo LED control is not implemented")

    async def close(self) -> None:
        return None
