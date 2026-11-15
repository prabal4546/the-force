"""Durable memory for the wearable brain.

Mirrors :mod:`command_store`: a single sqlite file, a context-managed
connection that creates tables on demand and translates low-level errors into a
typed :class:`AgentMemoryError`. Two kinds of memory:

  * episodic  one row per agent turn (what was seen, said, which tool fired),
  * facts     things the user asked us to remember.

:meth:`build_context` renders a compact, newest-first digest of both for the
next turn's ``memory_context``.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from typing import Optional
from uuid import uuid4

from pydantic import BaseModel


class TurnRecord(BaseModel):
    turn_id: str
    device_id: str
    image_artifact_id: Optional[str] = None
    understanding: Optional[str] = None
    command: str
    tool: Optional[str] = None
    answer: Optional[str] = None
    created_at: datetime


class FactRecord(BaseModel):
    fact_id: str
    device_id: str
    fact: str
    created_at: datetime


class AgentMemoryError(Exception):
    pass


class AgentMemory:
    def __init__(self, path: Path):
        self.path = Path(path)

    @contextmanager
    def connection(self):
        connection = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            connection = sqlite3.connect(self.path, timeout=5)
            connection.row_factory = sqlite3.Row
            with connection:
                connection.execute("""
                    CREATE TABLE IF NOT EXISTS turns (
                        turn_id TEXT PRIMARY KEY,
                        device_id TEXT NOT NULL,
                        image_artifact_id TEXT,
                        understanding TEXT,
                        command TEXT NOT NULL,
                        tool TEXT,
                        answer TEXT,
                        created_at TEXT NOT NULL
                    )
                """)
                connection.execute("""
                    CREATE TABLE IF NOT EXISTS facts (
                        fact_id TEXT PRIMARY KEY,
                        device_id TEXT NOT NULL,
                        fact TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    )
                """)
                yield connection
        except (sqlite3.Error, OSError, ValueError) as error:
            raise AgentMemoryError("Agent memory is unavailable") from error
        finally:
            if connection is not None:
                connection.close()

    def append_turn(
        self,
        device_id: str,
        image_artifact_id: Optional[str],
        understanding: Optional[str],
        command: str,
        tool: Optional[str],
        answer: Optional[str],
    ) -> TurnRecord:
        turn_id = uuid4().hex
        created_at = datetime.now(timezone.utc).isoformat()
        with self.connection() as connection:
            connection.execute(
                """INSERT INTO turns
                   (turn_id, device_id, image_artifact_id, understanding, command, tool, answer, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (turn_id, device_id, image_artifact_id, understanding, command, tool, answer, created_at),
            )
            row = connection.execute(
                "SELECT * FROM turns WHERE turn_id = ?", (turn_id,),
            ).fetchone()
            return TurnRecord(**dict(row))

    def list_turns(self, device_id: str, limit: int = 20) -> list[TurnRecord]:
        if not self.path.exists():
            return []
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM turns WHERE device_id = ? ORDER BY rowid DESC LIMIT ?",
                (device_id, limit),
            ).fetchall()
            return [TurnRecord(**dict(row)) for row in rows]

    def remember_fact(self, device_id: str, fact: str) -> FactRecord:
        fact_id = uuid4().hex
        created_at = datetime.now(timezone.utc).isoformat()
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO facts (fact_id, device_id, fact, created_at) VALUES (?, ?, ?, ?)",
                (fact_id, device_id, fact, created_at),
            )
            row = connection.execute(
                "SELECT * FROM facts WHERE fact_id = ?", (fact_id,),
            ).fetchone()
            return FactRecord(**dict(row))

    def list_facts(self, device_id: str, limit: int = 50) -> list[FactRecord]:
        if not self.path.exists():
            return []
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM facts WHERE device_id = ? ORDER BY rowid DESC LIMIT ?",
                (device_id, limit),
            ).fetchall()
            return [FactRecord(**dict(row)) for row in rows]

    def build_context(self, device_id: str, turn_limit: int = 5, fact_limit: int = 20) -> str:
        """Render a compact, newest-first memory digest for the next turn."""

        facts = self.list_facts(device_id, limit=fact_limit)
        turns = self.list_turns(device_id, limit=turn_limit)
        lines: list[str] = []
        if facts:
            lines.append("Known facts:")
            for fact in facts:
                lines.append(f"- {fact.fact}")
        if turns:
            lines.append("Recent turns (newest first):")
            for turn in turns:
                seen = turn.understanding or "(no image)"
                said = turn.answer or ""
                lines.append(f"- said \"{turn.command}\" | saw: {seen} | tool={turn.tool} | answer: {said}")
        return "\n".join(lines)
