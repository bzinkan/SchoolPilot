# Mobile Apps: GoPilot & PassPilot (Capacitor)

## Context

SchoolPilot has 3 products in one React/Vite web app: ClassPilot (Chromebook monitoring), GoPilot (student dismissal), and PassPilot (hall passes). We need **2 native mobile apps** for App Store and Google Play:

1. **GoPilot App** — Parents (check-in, pickup queue, QR), Teachers (homeroom roster), Office Staff (dismissal dashboard), Admin (setup/config)
2. **PassPilot App** — Full PassPilot with all roles (teachers, students, admin)

ClassPilot is desktop-only (WebRTC screen monitoring, Chrome extension) and gets **no mobile app**.

## Approach: Capacitor

**Why Capacitor over React Native:**
- All the UI already exists as React components (ParentApp.jsx, TeacherView.jsx, DismissalDashboard.jsx, PassPilot Dashboard/Kiosk)
- Capacitor wraps the existing Vite build in a native iOS/Android shell — zero UI rewrite
- Adds native APIs: push notifications, camera, secure storage, haptics
- React Native would mean rewriting every component from scratch for no benefit

**How 2 apps from 1 codebase:**
- Build-time env var `VITE_APP_PRODUCT=gopilot|passpilot` determines which product routes are included
- Two Capacitor config files (`capacitor.gopilot.config.ts`, `capacitor.passpilot.config.ts`) with separate app IDs, names, and native project directories
- Each build excludes ClassPilot routes entirely and defaults to the correct product

## Architecture

### Project Structure (new files)
```
schoolpilot-app/
  capacitor.gopilot.config.ts           # appId: com.schoolpilot.gopilot
  capacitor.passpilot.config.ts         # appId: com.schoolpilot.passpilot
  ios-gopilot/                           # iOS native project (GoPilot)
  android-gopilot/                       # Android native project (GoPilot)
  ios-passpilot/                         # iOS native project (PassPilot)
  android-passpilot/                     # Android native project (PassPilot)
  src/
    contexts/NativeContext.jsx           # Platform detection (isNative, product, platform)
    native/
      push.js                            # Push notification registration
      storage.js                         # Secure token storage (Preferences)
  resources/
    gopilot/icon.png, splash.png         # App icons & splash screens
    passpilot/icon.png, splash.png
```

### How Each App Knows Its Product

New `NativeContext.jsx`:
```jsx
const isNative = Capacitor.isNativePlatform();       // true in app, false on web
const product = import.meta.env.VITE_APP_PRODUCT;    // 'gopilot' or 'passpilot' (baked at build)
const platform = Capacitor.getPlatform();             // 'ios', 'android', or 'web'
```

### Key Modifications to Existing Files

**1. `src/App.jsx`** — Product-filtered routing
- Wrap tree with `<NativeProvider>`
- When `isNative && product === 'gopilot'`: exclude ClassPilot routes, exclude PassPilot routes, default redirect → `/gopilot` (role-based)
- When `isNative && product === 'passpilot'`: exclude ClassPilot routes, exclude GoPilot routes, default redirect → `/passpilot`
- When web (no product): current behavior unchanged
- Remove Landing/marketing routes in native builds

**2. `src/shared/utils/api.js`** — Dynamic API base URL
```js
// Currently: baseURL: '/api' (relies on Vite proxy / CloudFront origin)
// Native: must be absolute URL since there's no proxy
const baseURL = Capacitor.isNativePlatform()
  ? (import.meta.env.VITE_API_URL || 'https://api.schoolpilot.com/api')
  : '/api';
// Also: withCredentials: false for native (JWT only, no cookies)
```

**3. `src/contexts/AuthContext.jsx`** — Token persistence for native
- Currently keeps JWT in memory only (XSS protection) — lost when app is killed
- For native: persist via `@capacitor/preferences` (secure key-value store)
- On app launch: restore token from Preferences, call `/auth/me` to rehydrate session
- On login: save token to Preferences
- On logout: clear Preferences

**4. `src/contexts/SocketContext.jsx`** — Absolute socket URL
```js
// Currently: io(window.location.origin, ...) — broken in native (capacitor://localhost)
// Fix: use absolute backend URL when native
const socketUrl = Capacitor.isNativePlatform()
  ? (import.meta.env.VITE_API_URL || 'https://api.schoolpilot.com')
  : window.location.origin;
```

**5. `index.html`** — Safe area support
- Add `viewport-fit=cover` to viewport meta tag
- Add CSS env vars for `safe-area-inset-top/bottom`

**6. Backend CORS** — Allow Capacitor origins
- Add `capacitor://localhost` (iOS) and `http://localhost` (Android) to CORS allowlist in `src/app.ts` and `src/realtime/socketio.ts`

### Push Notifications (Phase 2)

- **Plugin**: `@capacitor/push-notifications`
- **Service**: Firebase Cloud Messaging (FCM) — handles both iOS (via APNs relay) and Android
- **Backend**: New `push_tokens` table, `POST /api/push/register`, `DELETE /api/push/unregister`
- **GoPilot alerts**: "Your child has been called", "Dismissal starting", pickup confirmation
- **PassPilot alerts**: "Pass approved", "Pass expired", "Student returned"

### Capacitor Plugins

| Plugin | Purpose |
|--------|---------|
| `@capacitor/core` | Platform detection, native bridge |
| `@capacitor/app` | App lifecycle, back button, deep links |
| `@capacitor/preferences` | Secure JWT persistence |
| `@capacitor/push-notifications` | Push notification registration (Phase 2) |
| `@capacitor/status-bar` | Status bar color/style |
| `@capacitor/splash-screen` | Splash screen control |
| `@capacitor/keyboard` | Keyboard behavior on forms |
| `@capacitor/haptics` | Tactile feedback |
| `@capacitor/network` | Offline detection |

### NPM Scripts (added to package.json)
```json
"build:gopilot": "VITE_APP_PRODUCT=gopilot vite build",
"build:passpilot": "VITE_APP_PRODUCT=passpilot vite build",
"cap:sync:gopilot": "npx cap sync --config capacitor.gopilot.config.ts",
"cap:sync:passpilot": "npx cap sync --config capacitor.passpilot.config.ts",
"mobile:gopilot": "npm run build:gopilot && npm run cap:sync:gopilot",
"mobile:passpilot": "npm run build:passpilot && npm run cap:sync:passpilot"
```

## Phased Implementation

### Phase 1: Proof of Concept — GoPilot on Simulator
1. Install Capacitor: `@capacitor/core`, `@capacitor/cli`, `@capacitor/preferences`, `@capacitor/app`, `@capacitor/status-bar`, `@capacitor/splash-screen`, `@capacitor/keyboard`
2. Create `capacitor.gopilot.config.ts` (appId `com.schoolpilot.gopilot`, webDir `dist`, ios path `ios-gopilot`, android path `android-gopilot`)
3. Create `src/contexts/NativeContext.jsx` (platform detection + status bar + splash screen)
4. Modify `api.js` — dynamic baseURL, conditional `withCredentials`
5. Modify `AuthContext.jsx` — token persistence via Preferences when native
6. Modify `SocketContext.jsx` — absolute URL when native
7. Modify `App.jsx` — wrap with NativeProvider, filter routes by product
8. Update `index.html` — `viewport-fit=cover`
9. Update backend CORS — add Capacitor origins
10. Build: `VITE_APP_PRODUCT=gopilot VITE_API_URL=http://localhost:4000 vite build`
11. Init native: `npx cap add ios --config capacitor.gopilot.config.ts`
12. Sync: `npx cap sync --config capacitor.gopilot.config.ts`
13. Open in Xcode, run on simulator

**Success**: Login → see ParentApp/TeacherView/Dashboard based on role, socket connected, no ClassPilot routes

### Phase 2: Full GoPilot App (iOS + Android)
- Add Android platform
- App icons and splash screens
- Push notifications (FCM + backend)
- Safe area insets across all GoPilot pages
- Android back button handling
- QR scanning verification in WebView
- Keyboard handling for form inputs
- App lifecycle: reconnect socket on foreground resume
- Test all 4 roles on physical devices

### Phase 3: PassPilot App
- Create `capacitor.passpilot.config.ts`
- Add iOS and Android platforms for PassPilot
- Route filtering for `VITE_APP_PRODUCT=passpilot`
- PassPilot-specific push notifications
- Hide "Back to ClassPilot" links in AppShell when native
- Test all roles on physical devices

### Phase 4: App Store Submission
- App Store screenshots (iPhone 6.7", 6.5", iPad 12.9")
- Play Store screenshots (phone + tablet)
- App descriptions, keywords, privacy policy URL
- iOS code signing (Apple Developer $99/year)
- Android keystore + Play Console ($25 one-time)
- Submit for review

## Dev Environment Requirements
- **macOS** required for iOS builds (Xcode 15+)
- **Android Studio** for Android builds
- **Apple Developer Account** for device testing + App Store
- **Google Play Developer Account** for Play Store
- **Firebase Project** for FCM push notifications

## Files Modified Summary

| Existing File | Change |
|------|--------|
| `schoolpilot-app/src/App.jsx` | NativeProvider wrapper, product-based route filtering |
| `schoolpilot-app/src/shared/utils/api.js` | Dynamic baseURL, conditional withCredentials |
| `schoolpilot-app/src/contexts/AuthContext.jsx` | JWT persistence via @capacitor/preferences |
| `schoolpilot-app/src/contexts/SocketContext.jsx` | Absolute socket URL for native |
| `schoolpilot-app/index.html` | viewport-fit=cover for safe areas |
| `schoolpilot-app/package.json` | Capacitor deps + mobile build scripts |
| `src/app.ts` | CORS: add capacitor://localhost origins |
| `src/realtime/socketio.ts` | CORS: add capacitor://localhost origins |

| New File | Purpose |
|----------|---------|
| `schoolpilot-app/capacitor.gopilot.config.ts` | GoPilot native config |
| `schoolpilot-app/capacitor.passpilot.config.ts` | PassPilot native config |
| `schoolpilot-app/src/contexts/NativeContext.jsx` | Platform detection context |
| `schoolpilot-app/src/native/storage.js` | Secure token storage wrapper |
| `schoolpilot-app/src/native/push.js` | Push notification utilities |

## Verification
1. `VITE_APP_PRODUCT=gopilot npm run build` — succeeds, dist contains no ClassPilot chunks
2. iOS simulator: login as parent → see ParentApp; login as teacher → see TeacherView
3. Socket.io connects and receives real-time dismissal updates
4. Token survives app kill + relaunch (Preferences persistence)
5. Web app (`npm run build` without VITE_APP_PRODUCT) still works identically — no regression
