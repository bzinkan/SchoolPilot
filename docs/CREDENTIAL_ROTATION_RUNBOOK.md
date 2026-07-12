# Production credential rotation

Use `scripts/security/rotate-production-credential.ps1` to plan, validate, apply,
or roll back one SchoolPilot production credential at a time. Secret values are
never printed and must never be placed in the repository. The tool mutates only
the selected SSM SecureString and the API/worker ECS task-definition revisions;
it does not build an image, push an image, run migrations, deploy the frontend,
or release the ClassPilot extension.

## Supported phases

| Phase | Terraform state-detachment name (nonsecret) | SSM suffix | Generic Apply |
|---|---|---|---|
| `google` | `google_client_secret` | `GOOGLE_CLIENT_SECRET` | Allowed with provider overlap; remains pending until a Google canary passes |
| `sendgrid` | `sendgrid_api_key` | `SENDGRID_API_KEY` | Allowed with provider overlap; remains pending until a delivery canary passes |
| `stripe-api` | `stripe_secret_key` | `STRIPE_SECRET_KEY` | Allowed only after exact Stripe account-identity validation |
| `stripe-webhook` | `stripe_webhook_secret` | `STRIPE_WEBHOOK_SECRET` | Allowed only with exact target-account evidence; remains pending until a webhook canary passes |
| `openai` | `openai_api_key` | `OPENAI_API_KEY` | Blocked; runtime injection has been removed and the unused key must be revoked |
| `session` | `session_secret` | `SESSION_SECRET` | Blocked until a tested traffic-free scale-to-zero or dual-read cutover exists |
| `jwt` | `jwt_secret` | `JWT_SECRET` | Blocked until a tested traffic-free scale-to-zero or dual-read cutover exists |
| `student` | `student_token_secret` | `STUDENT_TOKEN_SECRET` | Blocked; requires a specialized managed-Chromebook re-registration cutover |
| `database` | `database_url` | `DATABASE_URL` | Blocked; requires a coordinated RDS cutover |
| `pin-key` | `google_oauth_encryption_key` | `GOOGLE_OAUTH_ENCRYPTION_KEY` | Blocked; requires the staged dual-key PIN migration |

## One-time prerequisite: detach and remove the old local source

Application credentials must not be owned by Terraform state. Before any
rotation, create and verify both encrypted state backups, then run the reviewed
non-destructive detachment:

```powershell
pwsh -NoProfile -File scripts/terraform-detach-application-secret-state.ps1 `
  -Execute `
  -VerifiedDpapiBackupPath "C:\...\before-detach.dpapi" `
  -VerifiedRecoveryBackupPath "C:\...\before-detach.aesgcm" `
  -RecoveryCredentialDpapiPath "C:\...\rollout-recovery-passphrase.dpapi"
```

After detachment is verified, securely delete the ignored
`infra/secrets.auto.tfvars` file before starting a normal rotation. It is no
longer a recovery source or tool input. Plan checks `terraform state list` and
fails if the selected `module.ecs.aws_ssm_parameter.<name>` binding remains.
`REDIS_URL` stays Terraform-managed and is not a rotation phase.

## Safety contract

- Apply and Rollback require clean merged `main` equal to `origin/main`,
  including no untracked files. Validate, Apply, and Rollback require current
  `HEAD` to equal the exact SHA stored in the private plan manifest.
- Private plans, evidence, request files, and CurrentUser-DPAPI rollback
  material live under `%LOCALAPPDATA%\SchoolPilot\credential-rotation` by
  default. Repository paths and reparse points are rejected, and ACLs are
  restricted to the current Windows user and SYSTEM.
- Plan reads both the encrypted and decrypted views of the selected live SSM
  SecureString. Plaintext exists only briefly in memory: it is converted to a
  `SecureString`, SHA-256 hashed, DPAPI-protected for rollback, and discarded.
  The manifest stores version, ciphertext hash, plaintext hash, metadata, and
  rollback task-definition ARNs—not the value.
- Each external command has a bounded timeout. A timeout kills the process tree.
  An SSM timeout or command error is always reconciled by reading the exact
  current version, ciphertext hash, and plaintext hash.
- An SSM outcome is `intended` only when it is the exact next version with the
  desired plaintext hash, changed ciphertext hash, and unchanged metadata. An
  exact prior snapshot is `unchanged`. Every other outcome is `indeterminate`;
  the tool never overwrites it and records `manual_recovery_required`.
- Automatic rollback is attempted only while SSM exactly matches the
  tool-owned post-write snapshot. Rollback first checks exact version,
  ciphertext hash, plaintext hash, and metadata, writes the DPAPI-protected
  prior value, verifies the restored plaintext hash, then restores the captured
  API/worker task-definition ARNs.
- Secret-only cutover clones the current digest-pinned API and worker task
  definitions without changing image or configuration, registers new
  revisions, updates the services, and waits for exact convergence. It
  reconciles SSM immediately before and after the ECS change.
- Acceptance requires stable API/worker services, the original matching image
  digest, public `/health`, healthy ALB targets, positive API/worker startup
  logs, and no phase-specific or fatal log findings.
- Sanitized JSONL evidence uses event-specific field allowlists. Private gate
  evidence must be owner-only, outside the repository, and bound to the exact
  `runId`, `manifestHash`, `phase`, and creation time. Its expiry may be no more
  than 60 minutes after creation.

## Standard provider sequence

The operator creates, disables, or deletes provider credentials in the
provider's authenticated UI/API. This tool does not perform those actions. Its
only provider call is a read-only Stripe `GET /v1/account` identity check.

1. Create or roll the replacement while preserving the prior credential:
   - Google: add a secret to the existing OAuth client; do not use a disruptive
     reset.
   - SendGrid: create a Custom Access key with `Mail Send` only.
   - Stripe API: use a delayed expiration, never immediate expiration for a
     planned rotation.
   - Stripe webhook: roll only the exact SchoolPilot live endpoint with overlap.
2. Create a private read-only plan:

   ```powershell
   pwsh -NoProfile -File scripts/security/rotate-production-credential.ps1 `
     -Mode Plan -Phase google
   ```

3. Validate immediately before mutation:

   ```powershell
   pwsh -NoProfile -File scripts/security/rotate-production-credential.ps1 `
     -Mode Validate -Phase google `
     -PlanPath "C:\Users\<operator>\AppData\Local\SchoolPilot\credential-rotation\<run>\plan.json"
   ```

4. Apply with the replacement entered twice through hidden `SecureString`
   prompts:

   ```powershell
   pwsh -NoProfile -File scripts/security/rotate-production-credential.ps1 `
     -Mode Apply -Phase google `
     -PlanPath "C:\Users\<operator>\AppData\Local\SchoolPilot\credential-rotation\<run>\plan.json" `
     -ProviderOverlapConfirmed `
     -ConfirmProduction
   ```

5. Treat `aws_cutover_pending_provider_validation` as a hard hold. Do not revoke
   the prior credential. Complete the machine-verifiable canary:
   - Google: controlled sign-in plus an existing Classroom refresh-token
     resource read; require no `invalid_client`.
   - SendGrid: send to an operator-controlled alias and verify accepted and
     delivered.
   - Stripe API: the tool validates the replacement key with read-only
     `/v1/account` and requires the exact planned account ID.
   - Stripe webhook: send a harmless unhandled Workbench test event to the exact
     endpoint and require HTTP 200; never replay a real billing event.
6. Disable/delete the prior provider credential only after a separately reviewed
   provider-validation record exists. The rotation tool has no finalize or
   revoke operation.

If validation fails while the old provider credential remains enabled:

```powershell
pwsh -NoProfile -File scripts/security/rotate-production-credential.ps1 `
  -Mode Rollback -Phase google `
  -PlanPath "C:\Users\<operator>\AppData\Local\SchoolPilot\credential-rotation\<run>\plan.json" `
  -ProviderOldCredentialStillEnabled `
  -ConfirmProduction
```

## Stripe account-identity gate

Plan captures the current live Stripe account ID in the ACL-restricted manifest
using the current API key in memory. Apply validates a replacement API key with
the same read-only call and requires exact same-account identity.

A cross-account API key fails closed unless private, plan-bound evidence names
the exact old/new account IDs and confirms all of the following: zero active
subscriptions, zero unresolved production-database Stripe references, target
charges readiness, target payouts readiness, target business readiness, the
old `$42` disposition, and reviewed webhook-recreation readiness. A webhook
rotation always requires exact old/target account IDs plus reviewed endpoint
ownership and webhook recreation readiness.

No Stripe key, response payload, or account customer data is written to terminal
output or sanitized evidence.

## Internal and specialized phases

`session` and `jwt` remain Plan/Validate-only. An ordinary rolling deployment
temporarily mixes tasks using different signing keys, so acknowledgement files
do not make generic Apply safe. Implement and test either a traffic-free
scale-to-zero cutover or application dual-read support before enabling them.

`student` requires a specialized cutover that refreshes all synthetic and
managed-Chromebook registrations and keeps real-student onboarding blocked
until a physical managed-Chromebook smoke gate passes.

`database` requires coordinated RDS password change, connection draining,
application cutover, and a separate rollback design.

`pin-key` requires the external previous-key SecureString
`/schoolpilot/<environment>/GOOGLE_OAUTH_ENCRYPTION_KEY_PREVIOUS`, dual-read and
current-write support, the reviewed PIN-encryption migration, a zero-failure
idempotency pass, and a completed rollback window before cleanup.

## OpenAI removal order

Do not re-add `OPENAI_API_KEY` to API, worker, or emergency task definitions.
Generic OpenAI Apply is blocked. After the infrastructure change is merged:

1. Detach the OpenAI SSM resource from Terraform state.
2. Apply/register and deploy task definitions that omit `OPENAI_API_KEY`.
3. Verify the API, worker, and pre-registered emergency API revision all omit it.
4. Revoke the provider key.
5. While historical rollback task definitions still reference the SSM name,
   overwrite the detached SecureString with a non-secret tombstone.
6. After rollback anchors and historical tasks are retired, delete the SSM
   parameter.
7. Confirm the old ignored local secret source was already securely deleted
   after state detachment and before normal credential rotation.

## Local verification

The tests use only synthetic values and mocked AWS/Stripe handlers; they make no
network or cloud mutations:

```powershell
pwsh -NoProfile -File tests/credential-rotation.test.ps1
```
