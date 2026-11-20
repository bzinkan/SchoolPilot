# PassPilot battery indicator prototype

The user authorized preparing firmware and integration while collecting one
Bluefruit #4333, Adafruit #727 holder and Inland ESP32-WROOM-32D. Deliver a
reviewable, tested prototype in an isolated checkout; do not deploy or change
production settings. Existing dirty work in C:/GitHub/SchoolPilot is unrelated.

Use the independent Wi-Fi gateway and battery BLE puck already chosen in the
conversation. A browser/USB bridge requires an awake staff browser and does not
meet that choice. Wi-Fi on every puck spends more battery energy and duplicates
network enrollment. Use a single teacher/class pairing for this first prototype.

Implement firmware/passpilot-indicator/PROTOCOL.md exactly. Supply scoped,
revocable aggregate-only API access with no database schema migration, a staff
setup page, local secret/config generation, build verification and a practical
flash/setup/acceptance guide. Water is an explicit exact custom destination.
Do not infer occupancy from the school's roster or the current kiosk snapshot.

Physical battery runtime, school Wi-Fi, Chromebook sleep/USB power and actual
Bluetooth range remain hardware acceptance checks. The first light is blue;
the protocol preserves separate yellow office and red nurse categories.

Scope excludes production deployment, Chrome extension changes, automated class
switching, a school-wide device fleet and claims of measured hardware behavior.
