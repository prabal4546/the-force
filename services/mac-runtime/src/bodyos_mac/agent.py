"""The wearable "brain": understand a glasses photo + a band command, remember.

A band ``command`` (voice transcript) arrives alongside the latest glasses photo
and the device's accumulated memory. The agent produces one :class:`AgentTurn`:
it *understands* the image and picks exactly ONE tool:

  * ``answer``   respond to the question (using the image when present),
  * ``remember`` the user asked us to store a fact,
  * ``recall``   the user asked about the past, so summarize memory.

Mirrors the window-controller dual-impl pattern: :class:`SimulatedAgent` is
deterministic and needs no network (for tests and ``--simulate`` runs), while
:class:`GeminiAgent` is the real, lazily-initialised backend. Neither ever
raises to the caller — a failure settles as ``AgentTurn(status="failed", ...)``.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
import json
import os
from typing import Optional, Protocol


@dataclass(frozen=True)
class AgentTurn:
    """Outcome of one brain turn.

    ``status`` is ``"completed"`` once the agent produced a turn, or ``"failed"``
    if the backend could not (network, bad key, unparseable response); ``detail``
    carries the reason on failure.
    """

    status: str
    device_id: str
    event_id: str
    command: str
    image_artifact_id: Optional[str] = None
    understanding: Optional[str] = None
    answer: Optional[str] = None
    tool: Optional[str] = None
    detail: Optional[str] = None


class Agent(Protocol):
    def run_turn(
        self,
        device_id: str,
        event_id: str,
        command_text: str,
        image_bytes: Optional[bytes],
        image_mime: Optional[str],
        memory_context: str,
    ) -> AgentTurn: ...


# Chinese/English cue words that pick a tool deterministically. Kept here so the
# simulated brain and the real prompt agree on intent even without a model.
_REMEMBER_CUES = ("记住", "remember", "note that", "记一下")
_RECALL_CUES = ("今天", "刚才", "看了", "看到", "did i", "did we", "recall",
                "what did", "what have", "之前", "刚刚")


def _pick_tool(command_text: str) -> str:
    lowered = command_text.lower()
    if any(cue in command_text or cue in lowered for cue in _REMEMBER_CUES):
        return "remember"
    if any(cue in command_text or cue in lowered for cue in _RECALL_CUES):
        return "recall"
    return "answer"


class SimulatedAgent:
    """Deterministic, offline brain for tests and ``--simulate`` runs.

    Exercises all three tools by keyword, and lets the image presence and the
    memory context observably change its output so callers can assert on them.
    """

    def run_turn(
        self,
        device_id: str,
        event_id: str,
        command_text: str,
        image_bytes: Optional[bytes],
        image_mime: Optional[str],
        memory_context: str,
    ) -> AgentTurn:
        tool = _pick_tool(command_text)
        understanding: Optional[str] = None
        if image_bytes is not None:
            understanding = (
                f"(simulated) image {len(image_bytes)} bytes {image_mime}"
            )
        if tool == "remember":
            answer = f"(simulated) remembered: {command_text.strip()}"
        elif tool == "recall":
            context = memory_context.strip() or "nothing yet"
            answer = f"(simulated) recalling memory: {context}"
        else:
            if understanding is not None:
                answer = f"(simulated) answer about the image for: {command_text.strip()}"
            else:
                answer = f"(simulated) answer for: {command_text.strip()}"
        return AgentTurn(
            status="completed",
            device_id=device_id,
            event_id=event_id,
            command=command_text,
            image_artifact_id=None,
            understanding=understanding,
            answer=answer,
            tool=tool,
            detail=None,
        )


# Default model id. The hackathon account advertises "Gemini 3.8 Flash" and
# "Gemini 3.1 Pro"; the EXACT id string must be confirmed against the live
# list-models endpoint (GET .../v1beta/models?key=KEY) before a real run, and
# can be overridden with the GEMINI_MODEL env var without touching code.
_DEFAULT_GEMINI_MODEL = "gemini-3.8-flash"
_GEMINI_ENDPOINT = (
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
)

_PROMPT = (
    "You are the brain of a wearable assistant. You receive the latest photo "
    "from the user's glasses (if any), the user's spoken command, and a memory "
    "context of recent turns and remembered facts. Decide ONE tool:\n"
    "  - \"answer\": answer the user's question, using the image if present.\n"
    "  - \"remember\": the user asked you to remember something; store it.\n"
    "  - \"recall\": the user asked about the past; answer from memory context.\n"
    "First understand the image in one sentence. Then reply with STRICT JSON "
    "ONLY, no prose, no markdown fences, exactly:\n"
    "{\"tool\": \"answer|remember|recall\", \"understanding\": \"...\", \"answer\": \"...\"}"
)


class GeminiAgent:
    """Real brain backed by Google's Generative Language API.

    Lazily initialised: no SDK import and no client build at module import, so
    the server (and the whole test suite) runs with no key and no network. The
    request is issued with stdlib ``urllib`` so there is no hard dependency.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        timeout: float = 30.0,
    ) -> None:
        self._api_key = api_key
        self._model = model
        self._timeout = timeout

    def _resolve_key(self) -> str:
        key = self._api_key if self._api_key is not None else os.getenv("GEMINI_API_KEY", "")
        if not key:
            raise RuntimeError(
                "GEMINI_API_KEY is not set; run the API with --simulate for an "
                "offline brain, or export a key for the real Gemini backend."
            )
        return key

    def _resolve_model(self) -> str:
        if self._model:
            return self._model
        return os.getenv("GEMINI_MODEL", _DEFAULT_GEMINI_MODEL)

    def run_turn(
        self,
        device_id: str,
        event_id: str,
        command_text: str,
        image_bytes: Optional[bytes],
        image_mime: Optional[str],
        memory_context: str,
    ) -> AgentTurn:
        try:
            key = self._resolve_key()
            model = self._resolve_model()
            payload = self._build_payload(command_text, image_bytes, image_mime, memory_context)
            raw = self._post(model, key, payload)
            tool, understanding, answer = self._parse(raw)
        except Exception as error:  # never raise to the caller
            return AgentTurn(
                status="failed",
                device_id=device_id,
                event_id=event_id,
                command=command_text,
                image_artifact_id=None,
                understanding=None,
                answer=None,
                tool=None,
                detail=f"{type(error).__name__}: {error}",
            )
        return AgentTurn(
            status="completed",
            device_id=device_id,
            event_id=event_id,
            command=command_text,
            image_artifact_id=None,
            understanding=understanding,
            answer=answer,
            tool=tool,
            detail=None,
        )

    def _build_payload(
        self,
        command_text: str,
        image_bytes: Optional[bytes],
        image_mime: Optional[str],
        memory_context: str,
    ) -> dict:
        parts: list[dict] = [
            {"text": _PROMPT},
            {"text": f"Memory context:\n{memory_context or '(empty)'}"},
            {"text": f"User command:\n{command_text}"},
        ]
        if image_bytes is not None:
            parts.append(
                {
                    "inline_data": {
                        "mime_type": image_mime or "image/jpeg",
                        "data": base64.b64encode(image_bytes).decode("ascii"),
                    }
                }
            )
        return {"contents": [{"role": "user", "parts": parts}]}

    def _post(self, model: str, key: str, payload: dict) -> str:
        import urllib.error
        import urllib.request

        url = _GEMINI_ENDPOINT.format(model=model, key=key)
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self._timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
        candidates = body.get("candidates") or []
        if not candidates:
            raise RuntimeError(f"Gemini returned no candidates: {body}")
        parts = (candidates[0].get("content") or {}).get("parts") or []
        texts = [part.get("text", "") for part in parts if "text" in part]
        text = "".join(texts).strip()
        if not text:
            raise RuntimeError(f"Gemini returned no text parts: {body}")
        return text

    def _parse(self, raw: str) -> tuple[str, Optional[str], Optional[str]]:
        text = raw.strip()
        # Tolerate ```json ... ``` (or bare ```) fences around the JSON object.
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            if text.rstrip().endswith("```"):
                text = text.rstrip()[:-3]
        text = text.strip()
        # If there is surrounding prose, slice out the outermost JSON object.
        if not text.startswith("{"):
            start = text.find("{")
            end = text.rfind("}")
            if start == -1 or end == -1 or end < start:
                raise RuntimeError(f"Gemini response was not JSON: {raw!r}")
            text = text[start : end + 1]
        data = json.loads(text)
        tool = data.get("tool")
        if tool not in ("answer", "remember", "recall"):
            raise RuntimeError(f"Gemini returned an unknown tool: {tool!r}")
        understanding = data.get("understanding")
        answer = data.get("answer")
        return tool, understanding, answer
