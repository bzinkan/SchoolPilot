"""Export a successful PlatformIO build to ignored dist/ for flashing.

Run with the same PLATFORMIO_CORE_DIR used for the build. Configured firmware
contains credentials: keep the output private and out of source control.
"""
import hashlib
import json
import os
import pathlib
import shutil

root = pathlib.Path(__file__).resolve().parents[1]
core = pathlib.Path(os.environ.get("PLATFORMIO_CORE_DIR", pathlib.Path.home() / ".platformio"))
build = root / ".pio/build/esp32dev"
sources = [
    ("bootloader.bin", build / "bootloader.bin", "0x1000"),
    ("partitions.bin", build / "partitions.bin", "0x8000"),
    ("boot_app0.bin", core / "packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin", "0xe000"),
    ("firmware.bin", build / "firmware.bin", "0x10000"),
]
for _, source, _ in sources:
    if not source.is_file():
        raise SystemExit("Missing build output: run the esp32dev build successfully first.")
destination = root / "dist"
destination.mkdir(exist_ok=True)
files = []
for name, source, offset in sources:
    target = destination / name
    shutil.copyfile(source, target)
    files.append({"path": name, "offset": offset, "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
(destination / "manifest.json").write_text(json.dumps({
    "board": "esp32dev (original ESP32-WROOM-32D)",
    "sourceConfigPresent": (root / "include/config.h").is_file(),
    "configurationNote": "Current source presence only; rebuild after every settings change before exporting.",
    "warning": "Contains credentials when built with config.h; do not share or commit.",
    "files": files,
}, indent=2) + "\n", encoding="utf-8")
print("Exported firmware and flash manifest to gateway/dist (private; ignored by Git).")
