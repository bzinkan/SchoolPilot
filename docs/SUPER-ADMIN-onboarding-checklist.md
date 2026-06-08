# New School Onboarding — Super Admin Checklist

Use this when adding a school. The first section is what **you (Super Admin)** do at
creation; the second is what the **school's IT admin** does before devices connect.

---

## A. Super Admin — at school creation (`POST /api/admin/schools`)

1. **Name** — the school's display name. *(required)*
2. **Domain** — the school's **student email domain**, exactly as it appears in
   student emails. ⚠️ This is the anchor for cross-school isolation and device
   registration, so get it exact:
   - If students are `jane@students.lincoln.org`, set `domain = students.lincoln.org`
     (the sub-domain), **not** `lincoln.org`.
   - If a school uses more than one student domain, tell us — the current model is
     one primary domain per school.
3. **Products** — select the licenses the school bought (`CLASSPILOT`, `PASSPILOT`,
   `GOPILOT`). ⚠️ Without a license, that product's features are blocked for the
   school. Only include what they paid for.
4. **Admin account** — provide the school IT/admin's email (and name). This creates
   their login and emails them a temporary password. They are the school's admin.
5. **Status** — `active` for paying, or set `trialDays` for a trial.
6. *(optional)* **School hours / timezone** — sets monitoring windows.

A **settings row is now created automatically** for every school (you no longer need
to pass school-hours just to get one).

### Verify after creation
- [ ] School shows the correct **domain**.
- [ ] The right **product licenses** are attached.
- [ ] The **admin** received the welcome email and can log in.

---

## B. School IT admin — before any device connects

> ⚠️ **Students must be imported by IT. Devices for students who are NOT in the
> system are rejected** (no auto-enrollment by default — this is the intended
> policy). So importing the roster is a required step, not optional.

1. **Import the student roster** — via CSV, Google Directory, or Google Classroom.
   Each student's **email** must be included (registration matches devices to
   students by email).
2. **Connect Google** (if using Directory/Classroom import) — the admin connects
   Google once, in this school's context. The token is usable only for this school.
3. **Deploy the extension** (ClassPilot) to student devices via Google Admin
   force-install policy.
4. Devices register and are matched to the imported students. ✅

---

## C. Optional hardening (later, not required to launch)

- **Enrollment secret** — lock device registration to the school's managed extension
  policy (defense beyond the domain + import-required model). Backend is ready;
  needs an extension version that sends the key. See
  [SECURITY-device-enrollment-secret-spec.md](./SECURITY-device-enrollment-secret-spec.md).
- **Auto-enrollment** is OFF by default (the policy above). A school that explicitly
  wants zero-touch onboarding can enable it: `PATCH /api/classpilot/auto-enroll
  { "enabled": true }` (admin only). Leave it off unless a school asks.

---

## Why these matter (one-liners)
- **Domain** → powers cross-school isolation + correct device registration.
- **Licenses** → gate which products the school can use.
- **Import-before-connect** → an uninvited but valid-domain email can't self-enroll.
- See [SECURITY-tenant-isolation-readiness.md](./SECURITY-tenant-isolation-readiness.md)
  for the full isolation picture.
