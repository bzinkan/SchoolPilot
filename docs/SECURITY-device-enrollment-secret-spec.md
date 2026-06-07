# Device Enrollment Secret — Design & Spec

**Status:** Proposed (backend + extension coordination required)
**Closes:** the residual risk in `POST /api/classpilot/extension/register` after the
2026-06 domain-binding hotfix.
**Owners:** backend (this repo) + ClassPilot extension (separate repo —
`C:\GitHub\ClassPilot\extension`).

---

## 1. Why

`POST /api/classpilot/extension/register` is **unauthenticated** (a student
Chromebook has no user login at registration time). The 2026-06 hotfix anchored
registration to the **email domain** (a caller can no longer enroll into an
arbitrary `schoolId`; the school is derived from the verified email domain).

That closes the trivial "supply any schoolId" attack, but a residual risk
remains: anyone who knows a school's **email domain** (not secret) could still
register a fabricated `student@thatdomain.org` device and receive a signed device
JWT for that school — i.e., view/inject that school's live monitoring.

The complete fix is a **per-school enrollment secret**: a random key the school's
IT places in the managed Chrome extension config (force-installed policy). The
register endpoint requires it, so only a device the school actually deployed can
enroll. The key is not user-visible and never leaves the managed policy + our DB.

## 2. Trust model

| Anchor | Today | After this change |
|---|---|---|
| `schoolId` from request body | ❌ trusted (pre-hotfix) → ✅ must match email domain (post-hotfix) | ✅ ignored unless it matches the enrollment key's school |
| Email domain | ✅ trust anchor (post-hotfix) | ✅ still validated |
| **Enrollment secret** | — | ✅ **primary anchor** — proves the request came from the school's managed deployment |

## 3. Backend changes (this repo)

### 3.1 Schema (add to `settings`, which is per-school)

```ts
// src/schema/shared.ts  (settings table)
enrollmentKey: text("enrollment_key"),               // null until generated
enrollmentKeyRequired: boolean("enrollment_key_required").notNull().default(false),
```

### 3.2 Migration (idempotent, in `runStartupMigrations`, `src/index.ts`)

```sql
ALTER TABLE settings ADD COLUMN IF NOT EXISTS enrollment_key TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS enrollment_key_required BOOLEAN NOT NULL DEFAULT false;
```

No backfill needed — `enrollmentKeyRequired` defaults to `false`, so **existing
deployments keep working unchanged** (backward compatible). A school opts in only
after its extension is updated to send the key.

### 3.3 Admin endpoints (new, `requireRole("admin","school_admin")`)

```ts
// GET /api/classpilot/enrollment-key  -> { key: string|null, required: boolean }
// POST /api/classpilot/enrollment-key/rotate -> generates a new key, returns it
// PATCH /api/classpilot/enrollment-key  { required: boolean } -> toggles enforcement
```

Key generation: `crypto.randomUUID()` ×2 or `crypto.randomBytes(24).toString("base64url")`.
Only admins of that school can read/rotate it (scoped by `res.locals.schoolId`).

### 3.4 Validation in `POST /extension/register` (`src/routes/classpilot/devices.ts`)

Insert immediately after the school is resolved (after the domain-binding block):

```ts
// Per-school enrollment secret (defense beyond domain-binding). Backward compatible:
// only enforced once a school has opted in (enrollmentKeyRequired = true).
const settings = await getSettingsForSchool(resolvedSchoolId);
if (settings?.enrollmentKeyRequired) {
  const provided = String(req.body.enrollmentKey || "");
  if (!settings.enrollmentKey || provided !== settings.enrollmentKey) {
    return res.status(401).json({ error: "Invalid or missing enrollment key" });
  }
}
```

Use a constant-time compare (`crypto.timingSafeEqual`) for the key check.

### 3.5 Rollout (backend)

1. Ship schema + admin endpoints + validation with `enrollmentKeyRequired=false`
   everywhere (no behavior change).
2. Each school: admin generates a key, configures the extension policy (below),
   then flips `required=true`. From that point, only the managed extension can enroll.

## 4. Extension changes (separate repo — spec)

The extension must send the school's enrollment key on every
`POST /api/classpilot/extension/register` call.

1. **Managed policy key.** Add a `managed_schema` field, e.g. `enrollmentKey`
   (string), so school IT can set it via Google Admin console force-install policy
   (`chrome.storage.managed`).
2. **Read it at startup:** `chrome.storage.managed.get("enrollmentKey")`.
3. **Send it:** include `enrollmentKey` in the register request body alongside the
   existing `deviceId` / `studentEmail` / `schoolId`.
4. **Versioning:** bump the extension version; the backend stays backward compatible
   until the school flips `required=true`, so there's no flag-day.
5. **Failure UX:** on `401 Invalid or missing enrollment key`, surface "Contact your
   IT administrator — device enrollment is not configured" rather than silently retrying.

> ⚠️ Per repo convention, **a separate agent owns the extension** — coordinate via
> the extension repo's CLAUDE.md before implementing the extension side.

## 5. Test checklist

- [ ] School with `required=false`: existing register flow works unchanged.
- [ ] School with `required=true` + correct key: enroll succeeds.
- [ ] School with `required=true` + wrong/missing key: `401`, no device/student/JWT created.
- [ ] Key rotation invalidates the old key immediately.
- [ ] An attacker who knows the email domain but not the key: rejected.
- [ ] Only that school's admins can read/rotate the key (cross-school 404/403).

## 6. Residual risk after this lands

The enrollment key lives in managed policy on school-owned devices — appropriate
for the threat model (it gates *device enrollment*, not user auth). If a key leaks,
rotating it re-secures enrollment. This is the standard posture for unattended
device fleets.
