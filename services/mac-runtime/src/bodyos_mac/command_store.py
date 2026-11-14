from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from typing import Literal, Optional
from uuid import uuid4

from pydantic import BaseModel


class CommandRecord(BaseModel):
    command_id: str
    event_id: str
    device_id: str
    text: str
    status: Literal["received"]
    received_at: datetime


class CommandConflict(Exception):
    pass


class CommandStorageError(Exception):
    pass


class CommandStore:
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
                    CREATE TABLE IF NOT EXISTS commands (
                        command_id TEXT PRIMARY KEY,
                        device_id TEXT NOT NULL,
                        event_id TEXT NOT NULL,
                        text TEXT NOT NULL,
                        status TEXT NOT NULL,
                        received_at TEXT NOT NULL,
                        UNIQUE (device_id, event_id)
                    )
                """)
                yield connection
        except (sqlite3.Error, OSError, ValueError) as error:
            raise CommandStorageError("Command storage is unavailable") from error
        finally:
            if connection is not None:
                connection.close()

    def accept(self, device_id: str, event_id: str, text: str) -> CommandRecord:
        with self.connection() as connection:
            connection.execute(
                """INSERT INTO commands (command_id, device_id, event_id, text, status, received_at)
                   VALUES (?, ?, ?, ?, 'received', ?)
                   ON CONFLICT (device_id, event_id) DO NOTHING""",
                (uuid4().hex, device_id, event_id, text, datetime.now(timezone.utc).isoformat()),
            )
            row = connection.execute(
                "SELECT * FROM commands WHERE device_id = ? AND event_id = ?", (device_id, event_id),
            ).fetchone()
            if row["text"] != text:
                raise CommandConflict("Idempotency-Key was already used for a different command payload")
            return CommandRecord(**dict(row))

    def find_event(self, device_id: str, event_id: str) -> Optional[CommandRecord]:
        if not self.path.exists():
            return None
        with self.connection() as connection:
            row = connection.execute(
                "SELECT * FROM commands WHERE device_id = ? AND event_id = ?", (device_id, event_id),
            ).fetchone()
            return CommandRecord(**dict(row)) if row is not None else None

    def get(self, command_id: str) -> Optional[CommandRecord]:
        if not self.path.exists():
            return None
        with self.connection() as connection:
            row = connection.execute("SELECT * FROM commands WHERE command_id = ?", (command_id,)).fetchone()
            return CommandRecord(**dict(row)) if row is not None else None

    def list_commands(self, device_id: Optional[str], limit: int, offset: int) -> list[CommandRecord]:
        if not self.path.exists():
            return []
        with self.connection() as connection:
            if device_id is None:
                rows = connection.execute(
                    "SELECT * FROM commands ORDER BY rowid DESC LIMIT ? OFFSET ?", (limit, offset),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT * FROM commands WHERE device_id = ? ORDER BY rowid DESC LIMIT ? OFFSET ?",
                    (device_id, limit, offset),
                ).fetchall()
            return [CommandRecord(**dict(row)) for row in rows]
