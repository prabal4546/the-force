#!/usr/bin/env bash
# Builds "Mentra Bridge.app" and opens it. --build-only skips the launch.
set -euo pipefail
cd "$(dirname "$0")"
app="$PWD/build/Mentra Bridge.app"
if pgrep -f "$app/Contents/MacOS/MentraBridge" >/dev/null; then
  printf 'Quit the running Mentra Bridge before rebuilding.\n' >&2
  exit 1
fi
swift build
bin_dir="$(swift build --show-bin-path)"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin_dir/MentraBridge" "$app/Contents/MacOS/"
cp Info.plist "$app/Contents/Info.plist"
cp AppIcon.icns "$app/Contents/Resources/"
for bundle in "$bin_dir"/*.bundle; do
  if [[ -d "$bundle" ]]; then cp -R "$bundle" "$app/Contents/Resources/"; fi
done
# macOS reads the Bluetooth usage text from the bundle, so always launch the .app, not the bare binary.
codesign --force --sign - --entitlements MentraBridge.entitlements "$app"
if [[ "${1:-}" != "--build-only" ]]; then open "$app"; fi
