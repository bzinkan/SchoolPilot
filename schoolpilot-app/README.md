# SchoolPilot App

React 19 + Vite frontend for the SchoolPilot platform, served against the Express API in the repo root. The same codebase also produces the native GoPilot and PassPilot Android apps via Capacitor (`VITE_APP_PRODUCT` selects the product at build time; ClassPilot is desktop-only).

Product areas live under `src/products/`:

- `classpilot/` — classroom Chromebook monitoring dashboards
- `passpilot/` — digital hall passes and kiosk mode
- `gopilot/` — dismissal management for office staff, teachers, and parents

Shared state (auth, licenses, native platform detection, sockets, theme) lives in `src/contexts/`; the Axios client and other cross-product utilities are in `src/shared/`.

## Commands

```bash
npm run dev               # Vite dev server on http://localhost:5173
npm run lint              # ESLint over src
npm run build             # production web build
npm run build:gopilot     # GoPilot-only build (VITE_APP_PRODUCT=gopilot)
npm run build:passpilot   # PassPilot-only build
npm run mobile:gopilot    # product build + Capacitor sync (Android)
npm run mobile:passpilot  # product build + Capacitor sync (Android)
```
