# PassPilot classroom light prototype

One battery-powered **blue** light for restroom/water, with a USB-powered gateway
across the room. Firmware also supports separate yellow office and red nurse
lights by configuration; this first build pairs one gateway with one light.

## What is ready, and what still needs the parts

This folder contains the light firmware, ESP32 gateway firmware, configuration
tool and tests. The matching PassPilot API and staff page are source changes in
this branch. **They must be reviewed and deployed before live pairing will work.**
Nothing here changes a live school or flashes a board automatically.

Initial programming uses a computer and a data-capable USB cable. Afterwards,
the gateway runs on its own. A kiosk Chromebook can supply its USB power; it
does not run the gateway software and needs no browser extension. The gateway
connects independently to WiFi. Verify that the Chromebook keeps USB powered
during its actual kiosk/sleep routine, or use a USB wall adapter.

## Parts for this prototype

| Part | Exact selection |
| --- | --- |
| Light board | Adafruit Circuit Playground **Bluefruit #4333**, Micro Center SKU 058925 |
| Battery pack | Adafruit **#727 switched 3 × AAA JST holder**, SKU 847160 |
| Batteries | Three matching AAA cells; do not mix types or old/new cells |
| Gateway | Inland **ESP32-WROOM-32D**, SKU 027466; original ESP32, not ESP32-S3 |
| Programming/power cable | USB-A to **Micro-B data** cable, SKU 402008; USB-C to Micro-B SKU 498014 if your computer has USB-C only |
| Housing/mount | Nonmetallic round enclosure and mounting method; fit board, holder and battery access before drilling or gluing |

Both selected boards have Micro-B USB connectors. One cable can program them
one at a time, then power the gateway. The light runs from its battery holder.
The Bluefruit's ten built-in LEDs supply the light; no soldering or external
LED wiring is needed. The holder switch is the actual battery power switch.
Do not substitute the Circuit Playground Express: it lacks Bluetooth.

## 1. Prepare the light files

Read [light/README.md](light/README.md) and run its pinned preparation script.
It downloads the specified CircuitPython/library versions and creates a
`light/prepared` folder. Keep the board unplugged from the battery while
installing firmware. The finished light uses `code.py`, `indicator.py`, `lib/`
and your private `settings.toml` on the `CIRCUITPY` drive.

## 2. Create your PassPilot pairing

After this branch's API **and** web changes are deployed:

1. Sign in as the teacher who owns the classroom kiosk.
2. Open **`/passpilot/indicators`** on the same PassPilot website.
3. Choose **Follow a kiosk** and match the light pairing code shown on the
   classroom kiosk. Open PassPilot on the kiosk if it does not appear, then
   refresh the list. A kiosk can be paired between classes. **Follow one class**
   is available for a fixed class.
4. Leave water blank when the kiosk shares the built-in restroom option with water.
   For a separate custom water destination, enter its exact name and case.
5. Create the pairing and download its private JSON file on your setup computer.
   Save the pairing ID so you can revoke it later. It expires after 30 days.

**Follow a kiosk** counts active passes issued by that kiosk under your account
across scheduled class changes and routine kiosk restarts. An outstanding pass
still counts if the kiosk moves to its next class. If the previous student
cannot check in during the new class, mark the pass returned in PassPilot.
The gateway displays unavailable when the kiosk has no active session under
your account. If you have multiple tabs open on the same kiosk, releasing the
last session stops updates until you resume. A transfer to another owner
requires a new pairing. The light uses passes with recorded issuing-kiosk
information.

**Follow one class** counts your active passes for the selected class in the
school's current PassPilot class list. If the kiosk uses a separate ClassPilot
schedule, select **Follow a kiosk** to count passes from that schedule. In
either mode, a pass can stay active past its timer until returned or canceled.

## 3. Generate matching private settings

Install Node.js if it is not already available. From this repository's root,
run the following in PowerShell, replacing the pairing-file path:

```powershell
Copy-Item firmware/passpilot-indicator/setup.example.json firmware/passpilot-indicator/setup.local.json
# Edit setup.local.json with the approved WiFi SSID/password.
node firmware/passpilot-indicator/configure.mjs firmware/passpilot-indicator/setup.local.json "C:\Users\YOUR_NAME\Downloads\pairing-YOUR_ID.json"
```

Use an IT-approved **2.4 GHz personal WiFi network**. This firmware does not
implement captive portals or enterprise username/certificate enrollment.
School IT can identify a suitable network. Set `apiUrl` to the deployed site's
exact HTTPS state endpoint if it differs from `school-pilot.net`.

The generator verifies the site's HTTPS certificate and obtains its public root
certificate without sending the pairing token. An optional third argument is a
root CA PEM supplied by IT. Certificate failures stop setup. Never disable TLS
verification. The gateway also needs access to NTP for certificate validation.

The output is ignored by Git:

* `provisioned/light/settings.toml` — the light identity and Bluetooth key.
* `provisioned/gateway/config.h` — WiFi, read-only pairing token, the same key,
  exact light name, HTTPS address and root CA.
* `provisioned/manifest.json` — pairing ID, expiry and light identity, without keys.

Copy `settings.toml` to `light/prepared/` and then to `CIRCUITPY` as described in
the light guide. Copy `config.h` to `gateway/include/config.h` before compiling.
The generator refuses to overwrite `provisioned` so an accidental rerun cannot
silently change only one board's key. Keep these files private and out of shared
student storage. JSON files and compiled firmware can contain credentials.

## 4. Build and flash the ESP32 gateway

Follow [gateway/README.md](gateway/README.md) for its pinned PlatformIO toolchain,
build and USB upload commands. Select **esp32dev**, the original ESP32 target.
Do not copy the example credentials into a classroom build. Gateway programming
requires the computer's data USB connection. If Windows does not show a serial
port, install the CP210x driver from Silicon Labs as linked in that guide.

After upload, unplug the gateway from the setup computer and plug its USB cable
into the kiosk Chromebook or a wall adapter. Place it where the light's Bluetooth
signal can reach it. The gateway polls PassPilot approximately every five seconds.
The light and gateway need no USB connection to each other.

## 5. Assemble and test the light

1. With the battery pack switched **off**, insert three AAA batteries with the
   indicated polarity and connect its JST plug to the Bluefruit's battery socket.
2. Protect both boards from metal/contact shorts. Mount the Bluefruit and holder
   in the nonmetallic enclosure without covering the battery switch. Leave room
   for future battery replacement. Do a dry fit before permanent mounting.
3. Switch on. **Slow pulsing white** means status is unavailable. It should then
   go off once a valid clear status arrives.
4. Use the actual classroom kiosk to create a restroom pass. Expect solid blue
   within roughly one polling cycle after the pass becomes active.
5. Return the pass. Expect the blue light to turn off. Test two simultaneous
   matching passes if permitted: returning only one must leave it blue.
6. Test the exact water destination. Office and nurse passes should not light
   this blue prototype.
7. Unplug the gateway or interrupt its network. Within at most 30 seconds of
   the last successful status, the light must pulse white, not appear clear.
   Reconnect and confirm recovery. Also test restarting each board separately.
8. Test the intended locations with doors, people and the kiosk's normal sleep
   behavior. Measure battery runtime at the intended brightness before making
   a maintenance schedule. Runtime and room-wide range are not yet measured.

Clear = off, occupied = solid category color, unavailable = pulsing white.
Bluetooth disconnection can show unavailable sooner than the 30-second limit.

## Revoke or renew

Open `/passpilot/indicators`, enter the pairing ID and revoke it. The gateway's
last good status is allowed to live only for its remaining 30-second lease.
Lost staff access, an inactive school or license, an expired pairing, or a
Redis failure prevents fresh status. A class pairing also checks the selected
class and its source. A kiosk pairing checks that you still own the kiosk's
active session and that its remembered ownership is the same.

For renewal, create a replacement pairing and rebuild the gateway with its new
token. Preserve the existing `PP_LIGHT_NAME` and `PP_BLE_KEY_HEX` constants when
changing only the token; the light then does not need reflashing. Alternatively,
archive the entire old private `provisioned` folder, generate a new matching set,
and flash **both** boards. Revoke the old pairing after the replacement works.

## Software verification

Run from the repository root (see component guides for build dependencies):

```powershell
node --test firmware/passpilot-indicator/tests/test_config.mjs
python -m unittest discover -s firmware/passpilot-indicator/tests -p "test_light*.py"
python firmware/passpilot-indicator/gateway/scripts/test_native.py
```

See [PROTOCOL.md](PROTOCOL.md) for the authenticated BLE wire contract. Tests and
compilation cannot establish actual radio range, battery life or classroom WiFi
compatibility; those are the physical acceptance checks above.

See [VALIDATION.md](VALIDATION.md) for the completed software checks and remaining
database, deployment and hardware acceptance gates.
