"""Prepare local copy-ready files using pinned, SHA256-checked Adafruit sources.

Run with workstation Python 3. This does not access or flash an attached board.
No pip packages or generated credentials are needed by this preparation step.
"""

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import urllib.request
import zipfile


PACKAGES = (
    {
        "name": "Adafruit_CircuitPython_BLE",
        "version": "10.1.5",
        "url": "https://github.com/adafruit/Adafruit_CircuitPython_BLE/releases/download/10.1.5/adafruit-circuitpython-ble-py-10.1.5.zip",
        "sha256": "34a60a06859e23ccc379407a4fbcb7d9e34813f6df6776c94573bbbcfc576f85",
        "license_url": "https://raw.githubusercontent.com/adafruit/Adafruit_CircuitPython_BLE/10.1.5/LICENSE",
        "license_sha256": "3a942ddf29f03494277d70fcb072b38035165c229c3debf08b80a74c7826edd6",
        "prefix": "adafruit-circuitpython-ble-py-10.1.5/lib/",
    },
    {
        "name": "Adafruit_CircuitPython_NeoPixel",
        "version": "6.4.2",
        "url": "https://github.com/adafruit/Adafruit_CircuitPython_NeoPixel/releases/download/6.4.2/adafruit-circuitpython-neopixel-py-6.4.2.zip",
        "sha256": "3de27ccca804935ea99d445da6fa180df8296c1fa4c82389d4e886f3c25b6f09",
        "license_url": "https://raw.githubusercontent.com/adafruit/Adafruit_CircuitPython_NeoPixel/6.4.2/LICENSE",
        "license_sha256": "cffca9714e85201e3b41f5002d77441f3dec6cfed6e4a494cb76339852c897cc",
        "prefix": "adafruit-circuitpython-neopixel-py-6.4.2/lib/",
    },
)

UF2 = {
    "url": "https://downloads.circuitpython.org/bin/circuitplayground_bluefruit/en_US/adafruit-circuitpython-circuitplayground_bluefruit-en_US-10.3.2.uf2",
    "sha256": "cd56843cfa6d0f827ef36003fe6b372fec3111d06009302088d873d0be177954",
    "filename": "adafruit-circuitpython-circuitplayground_bluefruit-en_US-10.3.2.uf2",
}


def download_checked(url, expected):
    request = urllib.request.Request(url, headers={"User-Agent": "SchoolPilot-light-preparation/1"})
    with urllib.request.urlopen(request, timeout=30) as response:
        # Pinning the hash also bounds accepted content; cap unexpected downloads.
        data = response.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != expected:
        raise ValueError("A pinned Adafruit download failed SHA256 verification")
    return data


def prepare(output):
    output = output.resolve()
    uf2_data = download_checked(UF2["url"], UF2["sha256"])
    if uf2_data[:8] != bytes.fromhex("5546320a57515d9e"):
        raise ValueError("Unexpected CircuitPython UF2 header")
    downloads = []
    # Verify every download before writing any prepared files.
    for package in PACKAGES:
        archive = download_checked(package["url"], package["sha256"])
        license_text = download_checked(package["license_url"], package["license_sha256"])
        files = []
        with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
            for entry in zipped.infolist():
                if entry.is_dir() or not entry.filename.startswith(package["prefix"]):
                    continue
                name = PurePosixPath(entry.filename[len(package["prefix"]):])
                if name.is_absolute() or ".." in name.parts or not name.parts:
                    raise ValueError("Unexpected path in a pinned Adafruit download")
                if name.suffix != ".py":
                    raise ValueError("Unexpected library file in a pinned Adafruit download")
                files.append((name, zipped.read(entry)))
        if not files:
            raise ValueError("A pinned Adafruit download contains no library source")
        downloads.append((package, files, license_text))

    for package, files, license_text in downloads:
        for name, data in files:
            destination = output / "lib" / Path(*name.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        notices = output / "THIRD_PARTY_NOTICES"
        notices.mkdir(parents=True, exist_ok=True)
        (notices / (package["name"] + "-LICENSE.txt")).write_bytes(license_text)
    source = Path(__file__).resolve().parent
    (output / UF2["filename"]).write_bytes(uf2_data)
    for filename in ("code.py", "indicator.py"):
        (output / filename).write_bytes((source / filename).read_bytes())
    (output / "library-versions.json").write_text(
        json.dumps({"circuitpython": "10.3.2", "board": "circuitplayground_bluefruit", "uf2": UF2, "packages": PACKAGES}, indent=2) + "\n",
        encoding="utf-8",
    )
    print("Prepared verified library sources and light code in " + str(output))
    print("Add the locally generated settings.toml before copying to CIRCUITPY.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "prepared")
    options = parser.parse_args()
    prepare(options.output)
