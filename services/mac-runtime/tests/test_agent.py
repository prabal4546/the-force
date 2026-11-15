import unittest

from bodyos_mac.agent import GeminiAgent, SimulatedAgent


class SimulatedAgentTests(unittest.TestCase):
    def setUp(self):
        self.agent = SimulatedAgent()

    def run_turn(self, command, image_bytes=None, image_mime=None, memory=""):
        return self.agent.run_turn(
            device_id="band-1", event_id="evt-1", command_text=command,
            image_bytes=image_bytes, image_mime=image_mime, memory_context=memory,
        )

    def test_answer_tool_without_image(self):
        turn = self.run_turn("what is in front of me?")
        self.assertEqual(turn.status, "completed")
        self.assertEqual(turn.tool, "answer")
        self.assertIsNone(turn.understanding)
        self.assertIn("what is in front of me", turn.answer)

    def test_answer_tool_with_image_sets_understanding(self):
        turn = self.run_turn("what is this?", image_bytes=b"\x00\x01\x02", image_mime="image/png")
        self.assertEqual(turn.tool, "answer")
        self.assertIsNotNone(turn.understanding)
        self.assertIn("3 bytes", turn.understanding)
        self.assertIn("image/png", turn.understanding)

    def test_image_presence_changes_the_answer(self):
        without = self.run_turn("describe it")
        with_image = self.run_turn("describe it", image_bytes=b"abcd", image_mime="image/jpeg")
        self.assertNotEqual(without.answer, with_image.answer)
        self.assertIsNone(without.understanding)
        self.assertIsNotNone(with_image.understanding)

    def test_remember_tool_stores_the_phrase(self):
        turn = self.run_turn("remember this is my desk")
        self.assertEqual(turn.tool, "remember")
        self.assertIn("this is my desk", turn.answer)

    def test_remember_tool_short_form(self):
        turn = self.run_turn("remember my desk is here")
        self.assertEqual(turn.tool, "remember")

    def test_recall_tool_summarizes_memory_context(self):
        turn = self.run_turn("what did i see today?", memory="saw a red mug")
        self.assertEqual(turn.tool, "recall")
        self.assertIn("red mug", turn.answer)

    def test_recall_without_memory_still_answers(self):
        turn = self.run_turn("what did i see earlier?", memory="")
        self.assertEqual(turn.tool, "recall")
        self.assertIn("nothing yet", turn.answer)

    def test_memory_context_observably_affects_recall(self):
        empty = self.run_turn("recall what i saw", memory="")
        full = self.run_turn("recall what i saw", memory="a laptop and a plant")
        self.assertNotEqual(empty.answer, full.answer)


class GeminiAgentOfflineTests(unittest.TestCase):
    """The lazy Gemini backend must never raise and must fail cleanly offline."""

    def test_missing_key_returns_failed_not_raise(self):
        agent = GeminiAgent(api_key="")
        turn = agent.run_turn(
            device_id="band-1", event_id="evt-1", command_text="hi",
            image_bytes=None, image_mime=None, memory_context="",
        )
        self.assertEqual(turn.status, "failed")
        self.assertIsNone(turn.tool)
        self.assertIsNotNone(turn.detail)

    def test_parse_tolerates_json_fences(self):
        agent = GeminiAgent(api_key="x")
        fenced = """```json
{"tool": "answer", "understanding": "a mug", "answer": "it is a mug"}
```"""
        tool, understanding, answer = agent._parse(fenced)
        self.assertEqual(tool, "answer")
        self.assertEqual(understanding, "a mug")
        self.assertEqual(answer, "it is a mug")

    def test_parse_tolerates_surrounding_prose(self):
        agent = GeminiAgent(api_key="x")
        noisy = 'Sure! {"tool": "recall", "understanding": null, "answer": "earlier"} hope that helps'
        tool, _understanding, answer = agent._parse(noisy)
        self.assertEqual(tool, "recall")
        self.assertEqual(answer, "earlier")

    def test_parse_rejects_unknown_tool(self):
        agent = GeminiAgent(api_key="x")
        with self.assertRaises(RuntimeError):
            agent._parse('{"tool": "delete_everything", "answer": "no"}')

    def test_build_payload_embeds_image_as_inline_data(self):
        agent = GeminiAgent(api_key="x")
        payload = agent._build_payload("look", b"\x01\x02", "image/png", "ctx")
        parts = payload["contents"][0]["parts"]
        inline = [part for part in parts if "inline_data" in part]
        self.assertEqual(len(inline), 1)
        self.assertEqual(inline[0]["inline_data"]["mime_type"], "image/png")
        self.assertTrue(inline[0]["inline_data"]["data"])

    def test_build_payload_omits_image_when_absent(self):
        agent = GeminiAgent(api_key="x")
        payload = agent._build_payload("look", None, None, "ctx")
        parts = payload["contents"][0]["parts"]
        self.assertFalse(any("inline_data" in part for part in parts))


if __name__ == "__main__":
    unittest.main()
