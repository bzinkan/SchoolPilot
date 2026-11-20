# Circuit Playground Bluefruit light

Target: **Adafruit Circuit Playground Bluefruit #4333**, CircuitPython **10.3.2**.
This round board has ten RGB LEDs. It needs a diffuser/enclosure to resemble a
finished puck. This firmware does not modify a store-bought remote-control light.

## Prepare on the Windows computer

Run from the repository root:

```powershell
python firmware/passpilot-indicator/light/prepare_libraries.py
```

The script downloads **CircuitPython 10.3.2 UF2** and the official source releases
of **Adafruit BLE 10.1.5** and **NeoPixel 6.4.2**, checks pinned SHA256 digests, retains their MIT licenses, and
creates `light/prepared/`. It does not flash or contact a board. No installed pip
packages are required. The source libraries avoid `.mpy` ABI mismatches.

For this exact board and firmware, `hashlib`, `adafruit_pixelbuf`, `_bleio`, and
`neopixel_write` are built into CircuitPython. No `adafruit_hashlib` or separate
Pixelbuf download is required. The firmware uses native
`hashlib.new("sha256", data)` for HMAC-SHA256. Do not replace this with the unsupported
CircuitPython call `hashlib.sha256(data)`.

## Install when the board arrives

1. Use a **Micro-USB data cable** for the one-time installation. Connect the board
   to a computer, then double-press its RESET button to open the bootloader drive.
   Do not copy files to another drive by guessing its letter.
2. Install [CircuitPython 10.3.2 for this exact board](https://downloads.circuitpython.org/bin/circuitplayground_bluefruit/en_US/adafruit-circuitpython-circuitplayground_bluefruit-en_US-10.3.2.uf2)
   by copying the `.uf2` file already in `prepared/` onto the **bootloader** drive.
   Wait for the separate `CIRCUITPY` drive to appear. Do not copy the UF2 to `CIRCUITPY`.
   If it will not load, the [official board page](https://circuitpython.org/board/circuitplayground_bluefruit/)
   explains the required UF2 bootloader version **0.6.1 or later**.
3. Copy `prepared/lib/` and `prepared/THIRD_PARTY_NOTICES/` onto `CIRCUITPY`.
4. Copy the locally generated `settings.toml` onto `CIRCUITPY`. It must contain
   `PP_LIGHT_KEY_HEX` (64 hex characters), `PP_LIGHT_SUFFIX` (1–8 letters/digits),
   and `PP_LIGHT_CATEGORY_BIT = 1`. The key and suffix must match the gateway.
   Category **1 = blue/restroom + water**, **2 = yellow/office**, **4 = red/nurse**.
   Treat the settings file as a credential; never upload it to Git or share it.
5. Copy `prepared/indicator.py`, then `prepared/code.py` onto `CIRCUITPY` last.
   Safely eject the drive and disconnect USB. Plug the matching AAA holder into
   the board's battery connector, observing the holder's battery polarity.

The wall light then runs on batteries, without a USB cable. The separate gateway
needs continuous USB power; the Chromebook can supply that power if its USB port
stays awake. The Chromebook does not run this light's firmware or its Bluetooth
integration.

## Expected behavior

- A slow white pulse means startup, disconnection, stale information, or an
  installation fault. White is **not an available restroom** signal.
- Solid blue means at least one active restroom/water pass for the paired kiosk
  or class.
- Off means a fresh authenticated reading has no restroom/water pass. An unpowered
  board is also off; check the board's green power LED when diagnosing.
- The light advertises `PP-Light-<suffix>`. Active BLE scanning is required because
  the full name is sent in the advertising scan response.
- Every connection gets a hardware-random 8-byte challenge. Unsigned commands,
  old challenges, replays, invalid categories and TTLs never refresh the light.
  The last valid indication expires in at most 30 seconds, and disconnection
  changes it to the white pulse immediately on the next loop iteration.
- LEDs use 10% global brightness. Battery life, classroom visibility, BLE range,
  physical fit and behavior when the Chromebook sleeps need actual hardware tests.

If an installation fault occurs, the serial console prints a generic message
without secrets and the board pulses white until RESET. Check the required files,
firmware version and local settings before resetting.

## Workstation checks

```powershell
python -m unittest discover -s firmware/passpilot-indicator/tests -p 'test_light*.py'
python -m py_compile firmware/passpilot-indicator/light/code.py firmware/passpilot-indicator/light/indicator.py firmware/passpilot-indicator/light/prepare_libraries.py
```

These verify software behavior and Python syntax. They do not establish that
CircuitPython fits/boots on the actual board or that a physical BLE link works.

Official references: [board firmware and included modules](https://circuitpython.org/board/circuitplayground_bluefruit/),
[native hashlib API](https://docs.circuitpython.org/en/latest/shared-bindings/hashlib/index.html),
[BLE UART source at the pinned release](https://github.com/adafruit/Adafruit_CircuitPython_BLE/blob/10.1.5/adafruit_ble/services/nordic.py),
[NeoPixel pinned release](https://github.com/adafruit/Adafruit_CircuitPython_NeoPixel/releases/tag/6.4.2).
