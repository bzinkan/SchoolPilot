# Required Google Workspace Policies for ClassPilot

**Audience:** School IT administrators deploying ClassPilot on managed Chromebooks.

ClassPilot provides device-level classroom monitoring. To guarantee coverage, you **must** configure several Google Workspace Admin Console policies on the organizational unit (OU) containing your student Chromebooks. Without these policies, students can bypass monitoring simply by signing into the device with a personal Google account.

This requirement is identical to GoGuardian, Securly, Lightspeed, and every other Chrome-extension-based monitoring product. ClassPilot adds defense-in-depth on top (lockdown overlay + admin alert), but the primary mitigation is at the device policy layer.

---

## Required Policies (5 minutes to configure)

All policies are set in: **Google Admin Console → Devices → Chrome → Settings → User & browser** (apply to the student OU).

### 1. Sign-in restriction
**Purpose:** Prevent students from signing in with personal Google accounts.

| Setting | Value |
|---------|-------|
| **Sign-in restriction** | Restrict sign-in to a list of users |
| **Allowed users pattern** | `*@yourschool.org` (replace with your school's domain) |

**Result:** Personal accounts (gmail.com, yahoo.com, etc.) cannot sign in at all. Even Guest mode is blocked from these accounts.

### 2. Guest mode
**Purpose:** Prevent unmonitored browsing in Guest mode.

| Setting | Value |
|---------|-------|
| **Guest mode** | Disable guest mode |

### 3. Incognito mode
**Purpose:** Prevent students from bypassing the extension via incognito windows.

| Setting | Value |
|---------|-------|
| **Incognito mode** | Disallow incognito mode |

### 4. Force-install ClassPilot extension
**Purpose:** Ensure the extension is always installed and cannot be removed.

Navigate to **Apps & extensions → Users & browsers**:

| Setting | Value |
|---------|-------|
| **Installation policy** | Force install + pin to taskbar |
| **Extension ID** | (Provided by ClassPilot in onboarding email) |

### 5. Screen capture permission (for ClassPilot live view)
**Purpose:** Allow the ClassPilot extension to use `chrome.tabs.captureVisibleTab` for live screen previews.

Navigate to **Apps & extensions → Users & browsers → ClassPilot → Policy for extensions**:

```json
{
  "TabCaptureAllowedByOrigins": {
    "Value": ["*"]
  }
}
```

---

## Strongly Recommended (Additional Defense)

These aren't required for ClassPilot to function, but they meaningfully reduce off-task behavior and bypass attempts.

### 6. Account add restriction
Prevents students from adding additional accounts to the Chromebook beyond the primary sign-in.

| Setting | Value |
|---------|-------|
| **Multiple sign-in access** | Block multiple sign-in access |

### 7. Developer tools
Prevents students from disabling extensions via DevTools.

| Setting | Value |
|---------|-------|
| **Developer tools** | Never allow use of built-in developer tools |

### 8. Erase device data on sign-out (optional)
For 1:1 device deployments, this ensures a clean slate per session.

| Setting | Value |
|---------|-------|
| **Ephemeral mode** | Erase all local user data |

---

## What ClassPilot Adds On Top (Defense in Depth)

Even with all the above policies configured, ClassPilot includes additional safeguards:

| Layer | Behavior |
|-------|----------|
| **Personal email detection** | Extension detects gmail.com / yahoo.com / outlook.com / etc. on a managed device and shows a full-screen lockdown overlay instructing the student to sign in with their school account. |
| **Admin alert** | When a personal account is detected on a previously-enrolled device, school administrators receive an email alert (cooldown: 1 per device per 24 hours). |
| **Device-bound enrollment** | On managed Chromebooks, ClassPilot reads the device directory ID via `chrome.enterprise.deviceAttributes`. The device is bound to the school regardless of which user signs in. |

This is the **Block personal Google accounts on school devices** setting in the ClassPilot admin Settings page. It defaults to **enabled** for new schools.

---

## Verification Checklist

After configuring the policies, verify on a student Chromebook:

- [ ] Sign-in restriction works: attempt to sign in with a personal gmail.com — should be rejected
- [ ] Guest mode disabled: the "Browse as Guest" button should not appear on the sign-in screen
- [ ] Incognito disabled: Ctrl+Shift+N should produce a notification ("Incognito mode is not available")
- [ ] Extension force-installed: ClassPilot icon visible in toolbar, cannot be removed
- [ ] Extension functional: open `chrome://policy` to confirm `TabCaptureAllowedByOrigins` is applied

If you can sign in with a personal account on a test device, your policy is not yet applied — wait up to 24 hours for Google's policy propagation, then re-test.

---

## Troubleshooting

**Policies aren't taking effect:**
- Confirm policies are applied to the correct OU (containing the test device)
- On the device, navigate to `chrome://policy` and click "Reload policies"
- Policy changes can take up to 24 hours to propagate to enrolled devices

**Personal email detection isn't firing:**
- The ClassPilot extension setting **Block personal Google accounts on school devices** must be enabled (it is by default)
- The student must have a previously-registered device with the school for the admin email alert to fire
- Cooldown: 1 alert per device per 24 hours

**Device-bound enrollment isn't working:**
- `chrome.enterprise.deviceAttributes` is only available on policy-installed extensions on managed Chromebooks
- Requires ClassPilot to be force-installed via Google Admin Console (not user-installed from Chrome Web Store)
- Requires the device to be enterprise-enrolled

---

## Support

- **Technical questions:** [hello@school-pilot.net](mailto:hello@school-pilot.net)
- **Security incidents:** [security@school-pilot.net](mailto:security@school-pilot.net)
- **Privacy:** [privacy@school-pilot.net](mailto:privacy@school-pilot.net)
