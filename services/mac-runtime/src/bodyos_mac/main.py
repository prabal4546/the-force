from __future__ import annotations

import argparse
import asyncio

from .config import RuntimeConfig
from .server import BodyOSServer
from .vexo_adapter import RealVexoInput, SimulatedVexoInput
from .window_controller import MacOSWindowController, SimulatedWindowController


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="BodyOS Mac runtime")
    parser.add_argument(
        "--simulate",
        action="store_true",
        help="Use keyboard gestures and an in-memory window controller",
    )
    return parser


async def run(*, simulate: bool) -> None:
    config = RuntimeConfig.from_environment(simulate=simulate)
    if simulate:
        vexo = SimulatedVexoInput()
        windows = SimulatedWindowController()
    else:
        assert config.vexo_band_number is not None
        vexo = RealVexoInput(config.vexo_band_number)
        windows = MacOSWindowController()

    server = BodyOSServer(
        windows,
        vexo,
        host=config.host,
        port=config.port,
    )
    await server.run()


def main() -> None:
    args = build_parser().parse_args()
    try:
        asyncio.run(run(simulate=args.simulate))
    except (KeyboardInterrupt, ValueError) as exc:
        print(f"Stopped: {exc}")


if __name__ == "__main__":
    main()
