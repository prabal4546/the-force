from __future__ import annotations

import argparse
import asyncio

from .config import RuntimeConfig
from .govee_controller import GoveeLanController
from .keyboard_controller import MacOSKeyboardController, SimulatedKeyboardController
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
    parser.add_argument(
        "--real-windows",
        action="store_true",
        help="Use macOS Accessibility for windows while keeping simulated gestures",
    )
    return parser


async def run(*, simulate: bool, real_windows: bool = False) -> None:
    config = RuntimeConfig.from_environment(simulate=simulate)
    if simulate:
        vexo = SimulatedVexoInput()
        windows = MacOSWindowController() if real_windows else SimulatedWindowController()
        keyboard = MacOSKeyboardController() if real_windows else SimulatedKeyboardController()
    else:
        assert config.vexo_band_number is not None
        vexo = RealVexoInput(config.vexo_band_number)
        windows = MacOSWindowController()
        keyboard = MacOSKeyboardController()

    server = BodyOSServer(
        windows,
        vexo,
        host=config.host,
        port=config.port,
        keyboard=keyboard,
        govee=GoveeLanController(config.govee_device_ip)
        if config.govee_lan_enabled
        else None,
    )
    await server.run()


def main() -> None:
    args = build_parser().parse_args()
    try:
        asyncio.run(run(simulate=args.simulate, real_windows=args.real_windows))
    except (KeyboardInterrupt, ValueError) as exc:
        print(f"Stopped: {exc}")


if __name__ == "__main__":
    main()
