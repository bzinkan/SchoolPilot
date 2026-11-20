# ESP32 PassPilot indicator gateway

Target: Inland ESP32-WROOM-32D, Micro Center SKU 027466, CP2102 USB serial,
**original ESP32** (`esp32dev`). Do not select an ESP32-S3 board.

The gateway is powered from the kiosk Chromebook's USB port or a USB wall supply.
It does not communicate with Chrome, run a Chromebook extension, or need to remain
connected to the programming computer. It reaches the PassPilot API itself over
2.4 GHz Wi-Fi, then sends authenticated Bluetooth commands to the battery light.
The selected Chromebook must continue supplying USB power in its kiosk/sleep setup.

## Prepare and flash

1. Install Python and PlatformIO Core **6.1.18** (`python -m pip install platformio==6.1.18`).
   `platformio.ini` pins Espressif32 **6.12.0**, Arduino ESP32 **2.0.17**
   (package 3.20017.0), and NimBLE-Arduino **2.3.7**. The downloaded ESP32 toolchain
   is Xtensa 8.4.0+2021r2-patch5. Use a short PlatformIO core directory on Windows
   (the default `C:\Users\<user>\.platformio` works); very long temporary tool paths
   can exceed the compiler's Windows command-line limit.
2. Generate local settings with the setup utility described in the main prototype
   guide. It writes `provisioned/gateway/config.h`. Copy that file into this
   gateway's ignored `include/config.h` before building. The seven string constants
   match `include/config.example.h`. Use the same 32-byte BLE key and light name as
   the light's local settings. The root CA must trust the API's actual certificate
   chain. The endpoint must be `https://<hostname>/api/passpilot/indicators/state`
   on default port 443; alternate paths, credentials, query strings and fragments
   are deliberately rejected. The one-class API token expires in 30 days and must
   be replaced locally/reflashed when it expires or is revoked.
3. Connect the ESP32's **Micro-B USB** port to the programming computer with a data
   cable. A power-only cable cannot flash. Install the Silicon Labs CP210x USB
   driver if no serial port appears. After programming, this cable can power the
   gateway from the Chromebook across the room.
4. In this `gateway` directory run:

   ```powershell
   python -m platformio run -e esp32dev
   python -m platformio device list
   python -m platformio run -e esp32dev -t upload --upload-port COM7
   python -m platformio device monitor --port COM7 --baud 115200
   ```

   Replace `COM7` with the board's actual port. If upload waits at `Connecting`,
   hold **BOOT**, start upload, release BOOT once writing begins. Press **EN/RESET**
   after upload if necessary. Close the serial monitor before another upload.
5. Move the powered gateway to the kiosk Chromebook, within reliable BLE range of
   the light. A programming computer is needed only to flash/change settings.

Building without `config.h` succeeds but produces an **unconfigured** image. It
prints `Unavailable: configure gateway before use` and never connects. No shipped
sample binary contains Wi-Fi, pairing credentials, or a live account connection.

To export the latest successful build outside `.pio/build`, run:

```powershell
python scripts/export_firmware.py
```

The ignored/private `dist` folder contains the application, bootloader,
partitions and boot_app0 binaries plus SHA-256 hashes and offsets. These files
contain secrets once settings are configured. Prefer PlatformIO's upload command,
which uses the matching board/partition settings automatically. For an external
ESP32 flasher, the exported default offsets are 0x1000 bootloader, 0x8000
partitions, 0xe000 boot_app0, and 0x10000 firmware. Do not erase or flash a different
board with these outputs.

## Network and behavior

- This initial firmware supports an IT-approved 2.4 GHz SSID/password network.
  Enterprise 802.1X credentials and browser/captive-portal sign-ins need separate
  firmware/network provisioning; a Chromebook's own successful Wi-Fi connection
  does not give the ESP32 network access.
- Outbound DNS, HTTPS/443 to the API, and NTP/UDP123 to `time.google.com`,
  `pool.ntp.org`, or `time.cloudflare.com` must work. It waits for a completed NTP
  synchronization and a plausible date before any HTTPS request. School IT may
  substitute approved NTP hosts in source if required.
- Every five seconds it requests only a three-field category mask. TLS verifies
  the API hostname and configured root CA; redirects are disabled. It accepts only
  HTTP 200 JSON with a known body length at most 512 bytes and exact version 1,
  mask 0..7, maxAgeSeconds 30. No student data is requested or logged.
- Failed Wi-Fi/TLS/auth/HTTP/JSON never renews the previous lease. The gateway may
  send the previous valid state only for its remaining freshness time. BLE packets
  carry the floored remaining seconds and an HMAC tag using the light's fresh nonce.
  The light becomes unavailable after its existing deadline, or a disconnect.
- It connects only to the explicitly configured `PP-Light-<suffix>` advertising
  Nordic UART. A same-name impostor cannot authenticate a command without the
  shared key. The light supports one gateway connection at a time; leave phone BLE
  controller apps disconnected during use.
- Serial logs use generic state/connection messages. Never print the local config,
  API token, BLE key, Wi-Fi password or school/student identifiers for troubleshooting.

## Verification and hardware acceptance

Portable C++ tests exercise the same strict JSON parser, state deadline, bounded
fragmented BLE greeting parser, nonce/sequence and frame construction code:

```powershell
python scripts/test_native.py
# Or supply --compiler C:\path\to\g++.exe (or clang++).
```

These tests use an independent HMAC fixture to verify the message/tag contract;
the actual ESP32 mbedTLS HMAC implementation additionally self-tests that fixture
at device startup. Software compilation does not verify the self-test on hardware.

With the actual boards, verify sign-out lights blue, return clears it, two active
restroom/water passes keep blue until both return, other-class passes have no
effect, and network/API/gateway power loss gives a white unavailable pulse within
30 seconds. Verify a wrong BLE key cannot turn the light off. Check the full room
range, battery runtime, and the Chromebook's USB power while sleeping; these need
a physical test and have no measured guarantees yet.

Primary references: [PlatformIO ESP32 Dev Module](https://docs.platformio.org/en/latest/boards/espressif32/esp32dev.html),
[Espressif Arduino Wi-Fi API](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/wifi.html),
[NimBLE-Arduino 2.3.7 client example](https://github.com/h2zero/NimBLE-Arduino/blob/2.3.7/examples/NimBLE_Client/NimBLE_Client.ino),
[Silicon Labs CP210x drivers](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers).
