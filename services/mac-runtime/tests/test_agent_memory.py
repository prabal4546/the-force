from pathlib import Path
import tempfile
import unittest

from bodyos_mac.agent_memory import AgentMemory, AgentMemoryError


class AgentMemoryTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.memory = AgentMemory(Path(directory.name) / "memory.sqlite3")

    def test_episodic_turns_are_newest_first(self):
        self.memory.append_turn("band-1", "art-1", "a mug", "what is this", "answer", "a mug")
        self.memory.append_turn("band-1", "art-2", "a plant", "and this", "answer", "a plant")
        turns = self.memory.list_turns("band-1")
        self.assertEqual([turn.command for turn in turns], ["and this", "what is this"])
        self.assertEqual(turns[0].image_artifact_id, "art-2")
        self.assertEqual(turns[0].tool, "answer")

    def test_turns_are_scoped_to_device(self):
        self.memory.append_turn("band-1", None, None, "mine", "answer", "ok")
        self.memory.append_turn("band-2", None, None, "theirs", "answer", "ok")
        self.assertEqual([turn.command for turn in self.memory.list_turns("band-1")], ["mine"])
        self.assertEqual([turn.command for turn in self.memory.list_turns("band-2")], ["theirs"])

    def test_list_turns_honors_limit(self):
        for index in range(5):
            self.memory.append_turn("band-1", None, None, f"cmd-{index}", "answer", "ok")
        self.assertEqual(len(self.memory.list_turns("band-1", limit=2)), 2)

    def test_facts_round_trip_newest_first(self):
        self.memory.remember_fact("band-1", "this is my desk")
        self.memory.remember_fact("band-1", "the mug is mine")
        self.assertEqual(
            [fact.fact for fact in self.memory.list_facts("band-1")],
            ["the mug is mine", "this is my desk"],
        )

    def test_facts_are_scoped_to_device(self):
        self.memory.remember_fact("band-1", "a")
        self.memory.remember_fact("band-2", "b")
        self.assertEqual([fact.fact for fact in self.memory.list_facts("band-1")], ["a"])

    def test_build_context_includes_facts_and_turns(self):
        self.memory.remember_fact("band-1", "this is my desk")
        self.memory.append_turn("band-1", "art-1", "a red mug", "what is this", "answer", "a red mug")
        context = self.memory.build_context("band-1")
        self.assertIn("this is my desk", context)
        self.assertIn("a red mug", context)
        self.assertIn("what is this", context)

    def test_build_context_is_empty_for_unknown_device(self):
        self.assertEqual(self.memory.build_context("nobody"), "")

    def test_missing_database_reads_are_empty(self):
        fresh = AgentMemory(Path(tempfile.mkdtemp()) / "none.sqlite3")
        self.assertEqual(fresh.list_turns("band-1"), [])
        self.assertEqual(fresh.list_facts("band-1"), [])
        self.assertEqual(fresh.build_context("band-1"), "")

    def test_storage_failure_raises_typed_error(self):
        directory = tempfile.mkdtemp()
        bad_path = Path(directory) / "is-a-directory"
        bad_path.mkdir()
        memory = AgentMemory(bad_path)
        with self.assertRaises(AgentMemoryError):
            memory.append_turn("band-1", None, None, "cmd", "answer", "ok")


if __name__ == "__main__":
    unittest.main()
