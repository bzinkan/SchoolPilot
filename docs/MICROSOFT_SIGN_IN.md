# Microsoft sign-in (Entra ID)

Staff at a school that uses Microsoft 365 can sign in to the SchoolPilot web app with **Continue with Microsoft**. It is off everywhere until two things happen: the app registration is configured in production, and a super admin turns it on for a school with that school's Microsoft tenant ID. Students are unaffected: ClassPilot identifies them from the Chromebook's signed-in Google account.

## How it decides who gets in

1. The callback checks Microsoft's ID token: signature from Microsoft's published keys, audience (our client ID), issuer for the token's own tenant, the nonce from this browser session, expiry, and PKCE on the code exchange.
2. It looks for the SchoolPilot user already bound to that Microsoft account (`users.microsoft_id = <tenant id>:<object id>`), or else an existing user with the same email (the `email` claim, falling back to `preferred_username`).
3. Before writing anything, it requires that one of that user's active schools has Microsoft sign-in on **for the token's tenant**. A token from any other tenant is refused, even if it claims a staff member's email. This is the defence against the "nOAuth" email-claim takeover.
4. The first successful sign-in binds the Microsoft account to the user. Later sign-ins match on the binding, so an email change in Microsoft does not break sign-in.

Nobody is created by Microsoft sign-in: staff must already have a SchoolPilot account with the same email.

## One-time setup: register the app in Microsoft Entra

Do this once, in Schoolpilot's own Microsoft tenant (not a school's).

1. Go to the Microsoft Entra admin center (entra.microsoft.com), then **Applications → App registrations → New registration**.
2. Name: `SchoolPilot`. Supported account types: **Accounts in any organizational directory (Multitenant)**.
3. Redirect URI, platform **Web**: `https://school-pilot.net/api/auth/microsoft/callback`. For local development also add `http://localhost:4000/api/auth/microsoft/callback`.
4. **Overview**: copy the **Application (client) ID**. This is `MICROSOFT_CLIENT_ID`.
5. **Certificates & secrets → New client secret**: copy the **Value** (not the Secret ID). This is `MICROSOFT_CLIENT_SECRET`. Note its expiry date and plan a rotation before then.
6. **Token configuration → Add optional claim → ID → email**, so tokens carry the user's email address.
7. **API permissions**: keep the delegated Microsoft Graph `User.Read` default. The app requests only `openid profile email` at sign-in and never calls Microsoft Graph.

## Production wiring

The code ships dark. `/api/auth/providers` reports `microsoft: true` only when both variables are set **and** at least one school has Microsoft sign-in on. Until then the button stays hidden. Without the variables, `/api/auth/microsoft` answers 503.

To turn it on in production:

1. Store the client secret as the SSM SecureString `/schoolpilot/production/MICROSOFT_CLIENT_SECRET`. Do this yourself, and never paste the secret into a chat, file or commit.
2. Run the next backend deploy with the one-release flag and the application (client) ID:

   ```bash
   ./scripts/deploy.sh production --backend --activate-emergency --enable-microsoft-sign-in <client-id>
   ```

   The deploy then:
   - checks, without decrypting, that the parameter is a SecureString;
   - adds `MICROSOFT_CLIENT_ID` and the `MICROSOFT_CLIENT_SECRET` reference to the rendered API revision (the emergency API and scheduler worker inherit both);
   - verifies all three registered revisions before any service changes.
3. Omit the flag on later deploys. They clone the serving revisions, so both settings carry forward, and the runtime-secret preflight validates the secret with the others.

Check it worked: `GET https://school-pilot.net/api/auth/providers` returns `"microsoft": true` once a school has it turned on.

The Terraform ECS module does not declare these two settings yet. Adopting them into the Terraform baseline is a separate, later change, as for the RLS allowlist.

## Turning it on for a school

1. Ask the district's Microsoft administrator for their **Tenant ID**, found in the Entra admin center under **Overview**. It looks like `8f5c2a1e-...`.
2. Many school tenants require an administrator to approve new apps. A district Global Administrator signs in once with **Continue with Microsoft** and accepts the permission request with **Consent on behalf of your organization**. Until then, staff see "Your school's Microsoft administrator needs to approve SchoolPilot".
3. In the super admin dashboard, open the school and go to **Sign-in methods**. Paste the tenant ID and choose **Turn on Microsoft sign-in**. The change is audited as `school.sign_in_methods_updated`.
4. Optional: the school admin can turn off email and password sign-in in **ClassPilot → Settings → Staff sign-in**, so staff must use Microsoft or Google. The GoPilot staff app keeps password sign-in while the school has a GoPilot license.

Turning Microsoft sign-in off stops new Microsoft sign-ins at once, including for staff already bound. Existing sessions end normally. To cut off a person immediately, remove their membership.

## Troubleshooting

Each refusal is written to the audit log as `auth.rejected` with `metadata.method = "microsoft"` and a `reason`.

| Login page error | Audit reason | Meaning and fix |
| --- | --- | --- |
| `microsoft_not_enabled` | `microsoft_tenant_not_allowed` | The person's schools do not trust this tenant. Check the school's tenant ID in Sign-in methods, and that it is turned on. |
| `microsoft_no_account` | `no_account` | No SchoolPilot user has that email. Add the staff member, or fix the email so it matches Microsoft. |
| `microsoft_consent_required` | `provider_error` | The district's Microsoft administrator has not approved SchoolPilot (AADSTS65001). See step 2 above. |
| `identity_conflict` | `microsoft_identity_conflict` | The Microsoft account and the email point at two different SchoolPilot users, or the user is already bound to another Microsoft account (for example, one recreated in Entra). This needs central review. |
| `microsoft_failed` | `invalid_oauth_state`, `invalid_id_token`, `token_exchange_failed`, … | The sign-in expired, was replayed, or failed verification. Ask them to try again from the login page. Repeated `token_exchange_failed` usually means an expired or wrong client secret. |
| `microsoft_unavailable` | — | Production has no Microsoft app registration configured. |

A binding can't yet be cleared from the dashboard. Someone whose Microsoft account was recreated can still sign in with Google or a password.

## Not included

SAML 2.0 (ADFS, ClassLink, Okta) is the next step on the SSO roadmap and is not part of this change. Until Microsoft sign-in is live in production, the HECVAT (6.1, 6.2, 6.4) and the public Security page stay unchanged.
