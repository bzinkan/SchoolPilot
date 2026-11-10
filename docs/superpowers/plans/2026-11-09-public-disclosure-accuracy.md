# Public Disclosure Accuracy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify comparable vendor disclosures and correct Schoolpilot's public provider, privacy, security and AI information.

**Architecture:** Embed provider disclosures in Privacy as requested in the user's follow-up, and redirect the old provider route to the Privacy section. Make evidence-backed copy corrections; Security and its printable summary continue to share securityPosture.js. Preserve policy commitments and distinguish them from verified implementation and provider-account evidence.

**Tech Stack:** React/Vite, Markdown governance records, existing source and public vendor documents.

**Spec:** User request of November 9, 2026; CLAUDE.md compliance and public-claim requirements.

## Global Constraints

- Preserve unrelated dirty worktree changes and all product behavior.
- Put provider disclosures in /privacy#service-providers; remove the separate provider footer link and redirect /subprocessors for compatibility.
- Do not invent signed agreements, live feature activation, certifications, training guarantees or data residency.
- Preserve My Desk/AI-import pause, retired Live View and existing contractual response/notice commitments.
- Keep changed Security claims aligned with docs/soc2/claim-register.md and directly published HECVAT content.
- User follow-up authorizes frontend deployment after verification and safe branch cleanup; do not change backend/runtime configuration, access secrets or sign human-owned governance approvals.

## Review Focus

- Distinguish provider disclosures from proof of executed DPAs.
- Distinguish shipped but disabled integrations from generally available functionality.
- Disclose actual AI inputs and retained content without asserting anonymity or unverified provider-account terms.
- Keep existing data-retention commitments visible when implementation evidence is incomplete.
- Keep navigational labels and existing routes consistent without changing unrelated product pages.

## Task 1: Compare and audit

- [x] Verify GoGuardian's DPA and Securly's student privacy disclosures using their official sites.
- [x] Trace provider, privacy, security and AI claims to source, governance records and applicable official provider terms.
- [x] Record unresolved operating-evidence gaps without treating source or mocks as production proof.

## Task 2: Correct disclosures

**Files:** App.jsx, Landing.jsx; legal/Subprocessors.jsx, PrivacyPolicy.jsx, AITransparency.jsx, securityPosture.js, Security.jsx, SecuritySummary.jsx, TermsOfService.jsx; docs/HECVAT-LITE.md; docs/soc2/claim-register.md.

- [x] Embed service providers under Privacy and qualify vendor agreement verification; preserve legacy links by redirect.
- [x] Correct inaccurate data-flow, feature availability, security scanner, residency and procurement wording.
- [x] Synchronize dates and supporting claim records; do not approve any governance record.

## Task 3: Verify

- [x] Run npm run soc2:check and inspect all warnings (pending human approvals/evidence remain pending).
- [x] Run focused ESLint, full frontend lint (0 errors, 36 pre-existing warnings), and frontend production build.
- [x] Run existing relevant disclosure/retention contract checks (58 passing); add no tests that merely repeat revised prose.
- [x] Inspect desktop/mobile rendering of public pages, scrollable tables and footer navigation; observe legacy redirect fail before implementation and pass afterward.
- [x] Obtain independent review and correct missed chat/poll AI processing, exact-tab safety closure requests and count/delete retention wording; align supporting claim records.
- [x] Run git diff --check; preserve explicit evidence limitations in public copy and claim register.

## Task 4: Release and cleanup (user-authorized follow-up)

- [ ] Commit the scoped disclosure changes, open a PR, wait for checks, and merge without bypassing required checks.
- [ ] Wait for successful push CI on the resulting main commit; deploy the frontend from an isolated clean main checkout using scripts/deploy.sh.
- [ ] Verify live Privacy/legacy navigation, Security and AI disclosures and completed CloudFront invalidation.
- [ ] Remove this task's temporary checkout/branch and separately audited merged branches, preserving checked-out branches, open PRs, unmerged work and concurrent updates.

## Audit references

- GoGuardian DPA section 4.2: https://www.goguardian.com/policies/dpa (current list on request).
- Securly Privacy section 1(e): https://www.securly.com/privacy (Service Providers disclosed inside Privacy).
- AWS program scope: https://aws.amazon.com/compliance/programs/ and https://aws.amazon.com/compliance/services-in-scope/.
- Public /api/auth/providers returned google=true, microsoft=false on November 9; keep Microsoft unavailable/roadmap wording, per docs/MICROSOFT_SIGN_IN.md.
- Agreement confirmations/provider-account terms, precise deployed backup retention, and automatic school-year pass/dismissal deletion are not established by this source audit. The public wording and claim register disclose those limits.
