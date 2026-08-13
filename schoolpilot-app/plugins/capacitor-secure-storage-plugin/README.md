# SchoolPilot secure-storage fork

This repository-controlled fork preserves the upstream JavaScript package and
Capacitor plugin names while replacing the Android implementation with a
fail-closed Android Keystore design.

- Android 7.0 / API 24 is the minimum supported version.
- Values are encrypted with a per-install Android Keystore AES-256-GCM key.
- No legacy SDK16 or plaintext SharedPreferences fallback exists.
- Initialization, encryption, decryption, and persistence errors reject the
  Capacitor call.
- Legacy or corrupt stored values are never decoded. When Keystore access is
  healthy, they are synchronously deleted with a verified commit and reported
  as missing so the app returns to signed-out state; cleanup failure rejects.

The package is installed through a local `file:` dependency so a clean install
uses the reviewed source in this directory rather than an unpatched registry
release. It is derived from `capacitor-secure-storage-plugin` and retains that
project's MIT license.
