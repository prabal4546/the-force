#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]

REQUIRED = [
    ROOT / "README.md",
    ROOT / "apps/ios/Modules/ProductCore/DemoCoordinator.swift",
    ROOT / "services/mac-runtime/src/bodyos_mac/main.py",
    ROOT / "shared/protocol/events.schema.json",
    ROOT / "vendor/vexo-open-kit/README.md",
]


def main() -> int:
    failures: list[str] = []

    for path in REQUIRED:
        if not path.exists():
            failures.append(f"missing required path: {path.relative_to(ROOT)}")

    for path in (ROOT / "shared/protocol/examples").glob("*.json"):
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError as exc:
            failures.append(f"invalid JSON in {path.relative_to(ROOT)}: {exc}")
            continue
        for key in ("version", "id", "type"):
            if key not in data:
                failures.append(f"{path.relative_to(ROOT)} is missing {key}")

    env_example = (ROOT / ".env.example").read_text()
    if "VEXO_BAND_NUMBER=42" in env_example:
        failures.append("example Vexo band number must never be committed")

    if failures:
        print("Repository checks failed:")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("Repository structure and shared examples look good.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
