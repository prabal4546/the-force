"""Serialized dispatch for the wearable brain.

Mirrors :class:`GestureDispatcher`: the HTTP API accepts a band ``command`` and
returns ``202`` immediately, then hands the turn to this dispatcher, which runs
the (blocking) :meth:`Agent.run_turn` off the event loop. Turns are serialized
so two quick commands never interleave their model calls or memory writes.
"""

from __future__ import annotations

import asyncio
from typing import Optional

from .agent import Agent, AgentTurn


class AgentDispatcher:
    def __init__(self, agent: Agent) -> None:
        self._agent = agent
        # Python 3.9 requires a running event loop when asyncio.Lock is
        # constructed. The API creates its dispatcher synchronously, so bind
        # the lock lazily on the first turn instead.
        self._lock: Optional[asyncio.Lock] = None

    def _turn_lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def run_turn(
        self,
        device_id: str,
        event_id: str,
        command_text: str,
        image_bytes: Optional[bytes],
        image_mime: Optional[str],
        memory_context: str,
    ) -> AgentTurn:
        async with self._turn_lock():
            return await asyncio.to_thread(
                self._agent.run_turn,
                device_id,
                event_id,
                command_text,
                image_bytes,
                image_mime,
                memory_context,
            )
