import asyncio
import threading
import time
import unittest

from bodyos_mac.agent import AgentTurn, SimulatedAgent
from bodyos_mac.agent_dispatcher import AgentDispatcher


class RecordingAgent:
    """Counts calls and records the max concurrency observed across turns."""

    def __init__(self):
        self.calls = 0
        self.active = 0
        self.max_active = 0
        self._lock = threading.Lock()

    def run_turn(self, device_id, event_id, command_text, image_bytes, image_mime, memory_context):
        with self._lock:
            self.calls += 1
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        time.sleep(0.02)
        with self._lock:
            self.active -= 1
        return AgentTurn(
            status="completed", device_id=device_id, event_id=event_id,
            command=command_text, tool="answer", answer="ok",
        )


class AgentDispatcherTests(unittest.TestCase):
    def test_runs_the_agent_and_returns_its_turn(self):
        dispatcher = AgentDispatcher(SimulatedAgent())
        turn = asyncio.run(dispatcher.run_turn(
            "band-1", "evt-1", "记住这是我的工位", None, None, "",
        ))
        self.assertEqual(turn.status, "completed")
        self.assertEqual(turn.tool, "remember")

    def test_passes_memory_context_through_to_recall(self):
        dispatcher = AgentDispatcher(SimulatedAgent())
        turn = asyncio.run(dispatcher.run_turn(
            "band-1", "evt-2", "what did i see", b"img", "image/png", "a laptop",
        ))
        self.assertEqual(turn.tool, "recall")
        self.assertIn("a laptop", turn.answer)

    def test_turns_are_serialized(self):
        agent = RecordingAgent()
        dispatcher = AgentDispatcher(agent)

        async def drive():
            await asyncio.gather(*[
                dispatcher.run_turn("band-1", f"evt-{index}", "hi", None, None, "")
                for index in range(6)
            ])

        asyncio.run(drive())
        self.assertEqual(agent.calls, 6)
        # The lock must prevent any two turns from running concurrently.
        self.assertEqual(agent.max_active, 1)


if __name__ == "__main__":
    unittest.main()
