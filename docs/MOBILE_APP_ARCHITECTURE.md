# SchoolPilot Mobile Architecture

## Supported native applications

- **GoPilot Android** (`com.schoolpilot.gopilot`) — staff-only dismissal dashboard and teacher workflow.
- **PassPilot Android** (`com.schoolpilot.passpilot`) — PassPilot staff and kiosk workflows.

ClassPilot remains web/Chrome-extension based. No SchoolPilot iOS project is currently supported or released.

## GoPilot boundary

The GoPilot Android bundle may include only authenticated staff surfaces:

- administrators and office staff: session controls, staff car-number/direct-search arrival intake, live queue, bus/walker workflows, and authorized pickups;
- teachers: assigned-student view and release workflow;
- administrators: school setup and versioned settings.

Parent registration, parent portal, child linking, QR arrival, parent change requests, and parent notifications are not native routes. Historical parent data remains server-side and does not grant access.

## Build configuration

The Vite variant selects the product. Capacitor uses `capacitor.gopilot.config.ts` with `android-gopilot/` or `capacitor.passpilot.config.ts` with `android-passpilot/`.

```bash
cd schoolpilot-app
npm run mobile:gopilot
npm run mobile:passpilot
```

Each command builds its product assets, copies the matching Capacitor configuration, and synchronizes that Android project's plugins. Inspect both generated plugin registries after dependency changes; a stale generated project can retain references to removed packages.

## Credential storage

Bearer tokens must be stored only with the repository-controlled
`schoolpilot-app/plugins/capacitor-secure-storage-plugin` fork. Its Android
implementation requires API 24, encrypts each value with a randomized
AES-256-GCM operation backed by Android Keystore, and stores only the versioned
ciphertext envelope in private SharedPreferences. It has no SDK16/plaintext
fallback. Keystore, cryptographic, and persistence failures reject the
Capacitor call, and sign-in publishes a token only after an immediate protected
readback matches the value written. Capacitor Preferences, localStorage,
bundled files, and plaintext SharedPreferences must never contain bearer
tokens. On upgrade, an unreadable or retired plaintext-format token is never
decoded or published: the native fork synchronously removes the residue,
verifies its removal, and returns the app to signed-out state. A cleanup
failure rejects the Capacitor call and keeps authentication failed closed.

Native GoPilot sign-in currently uses school-issued staff email and password. Google OAuth and custom-scheme callbacks are disabled in the Android app until a verified HTTPS App Link flow is implemented and reviewed.

Required verification:

```bash
npm run test:gopilot-mobile-security
npm run test:passpilot-mobile-security
```

The checks compare the installed dependency with the controlled fork, inspect
the generated projects and merged API-24 manifests, and unpack each debug APK's
DEX payload to require the AES-GCM implementation and reject the retired SDK16
and RSA fallback classes. The gates enforce the exact reviewed Java source and
compiled-class allowlists, verify legacy/corrupt token cleanup is present, and
confirm no plaintext token fallback exists,
parent routes are absent from the GoPilot bundle, and signing secrets are not
embedded in Gradle.

## Release signing

Signing credentials are never committed. Release builds read these protected CI/distribution secrets:

- `GOPILOT_KEYSTORE_PATH`
- `GOPILOT_KEYSTORE_PASSWORD`
- `GOPILOT_KEY_ALIAS`
- `GOPILOT_KEY_PASSWORD`
- `PASSPILOT_KEYSTORE_PATH`
- `PASSPILOT_KEYSTORE_PASSWORD`
- `PASSPILOT_KEY_ALIAS`
- `PASSPILOT_KEY_PASSWORD`

Each product's Gradle project fails a requested release build when any of its four values is missing; debug builds use Android's debug signing and do not require release secrets. Rotate both exposed upload/signing credentials through the applicable app distribution provider; removing values from Git does not rotate them.

## Release checklist

1. Confirm the backend containment release is deployed and parent GoPilot endpoints return `410 GOPILOT_PARENT_PORTAL_DISABLED`.
2. Run lint, the GoPilot production build, staff workflow tests, and the mobile security check.
3. Run `npm run cap:sync:gopilot` and inspect generated plugin registration.
4. Build a release AAB with protected signing secrets.
5. Inspect the final AAB/APK for parent route strings, plaintext credentials, development hosts, and unexpected permissions.
6. Test administrator, office-staff, and teacher routing on a clean Android installation.
7. Verify sign-in fails closed when secure storage is intentionally unavailable.
8. Publish the Android release separately from the SchoolPilot web/API deployment.
