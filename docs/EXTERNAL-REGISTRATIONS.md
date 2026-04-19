# External Registrations — Action Checklist

Free / low-cost third-party validations that strengthen procurement positioning.
Do these in the order listed — each takes minutes to apply but weeks to complete.

---

## 1. Common Sense Education — Privacy Evaluation

**Cost:** Free
**Timeline:** 4-8 weeks for evaluation
**Value:** Public privacy rating badge cited by many district IT teams; equivalent weight to iKeepSafe in many procurement processes

### How to submit

1. Go to **https://privacy.commonsense.org/vendor** (vendor submission portal)
2. Create a free vendor account with `hello@school-pilot.net`
3. Fill out the privacy assessment form covering:
   - Product purpose and target age range
   - Data collection practices
   - Data sharing practices
   - Safety and parental controls
   - Advertising and tracking disclosures
4. Attach/reference:
   - Privacy Policy URL: `https://school-pilot.net/privacy`
   - Terms of Service URL: `https://school-pilot.net/terms`
   - Subprocessors URL: `https://school-pilot.net/subprocessors`
   - Security page URL: `https://school-pilot.net/security`

### What Common Sense evaluates

They rate products as **Pass / Warning / Fail** across five categories:
- **Data collection** — minimum necessary
- **Data sharing** — third-party disclosure practices
- **Data security** — encryption, breach response
- **Data rights** — access, correction, deletion
- **Advertising** — targeted ads, tracking

SchoolPilot is positioned to pass all five given current Privacy Policy and WISP.

### Key talking points for the submission

- "School official" under FERPA with explicit direct-control clause
- No student data used for advertising, data mining, or AI training
- 72-hour breach notification, 30-day data destruction on contract end
- 45-day parent access response, 15-day amendment response
- All data stored in US (AWS us-east-1)
- Age range: K-12 (with COPPA school-consent exception for under-13)

### After approval

Add badge to `/security` page footer: "Evaluated by Common Sense Education — Passes Privacy"

---

## 2. 1EdTech Consortium — Free Basic Membership

**Cost:** Free for basic (Contributor) membership
**Timeline:** 1-2 weeks to approve
**Value:** Listed in 1EdTech vendor directory; signals participation in EdTech interoperability standards (OneRoster, Caliper Analytics, LTI)

### How to join

1. Go to **https://www.1edtech.org/membership**
2. Select "Contributor" membership (free tier)
3. Apply with:
   - Company: Schoolpilot LLC
   - Primary contact: hello@school-pilot.net
   - Product description: "K-12 classroom management platform combining device monitoring (ClassPilot), digital hall passes (PassPilot), and dismissal management (GoPilot)"
4. Agree to 1EdTech participation terms

### Benefits of basic membership

- Listed in 1EdTech product directory
- Access to interoperability standards documentation (OneRoster 1.2, etc.)
- Ability to self-attest to OneRoster conformance (future: sync rosters from district SIS systems without custom integration)

### Adjacent program: TrustEd Apps

1EdTech's **TrustEd Apps** program is their equivalent of Common Sense's privacy evaluation. Basic self-attestation is free. The full evaluation ($) is optional later. Apply for basic self-attestation alongside membership.

---

## 3. HECVAT Lite — No registration required

**Cost:** Free (self-assessed)
**Timeline:** Document ready now
**Value:** Pre-answered security questionnaire to hand to districts during procurement

See `docs/HECVAT-LITE.md` in this repo. Host a copy publicly at `/security/hecvat-lite` if desired, or provide under NDA on request.

Districts ask for HECVAT **more often than iKeepSafe**. Having a pre-answered version saves procurement cycles.

---

## 4. Student Data Privacy Consortium (SDPC) — NDPA

**Cost:** Free
**Timeline:** Ongoing — sign NDPAs per district
**Value:** National Data Privacy Agreement is what districts actually sign (most states accept it)

### How to use

1. Review template at **https://privacyregistry.org** (SDPC registry)
2. When a district requests a DPA, offer to sign their NDPA (most use Standard NDPA v1.0a or v2.0)
3. Terms Section 7 already commits to honoring NDPA terms on execution

### Key state-specific variants to know

- **California**: CSDPA (California Student Data Privacy Agreement)
- **Texas**: TX-NDPA
- **Illinois**: Illinois SOPPA-compliant NDPA
- **New York**: NY Ed Law 2-d Parent Bill of Rights

All can be signed on a per-district basis without additional infrastructure.

---

## Priority Order

**Week 1:**
1. Submit to Common Sense Education (takes 10-15 min, then wait 4-8 weeks)
2. Apply for 1EdTech basic membership (10 min)
3. Publish HECVAT Lite on `/security` page (done — in repo)

**Week 2-3:**
4. Follow up on both applications
5. Begin outreach to first target districts with HECVAT in hand

**Ongoing:**
6. Sign district NDPAs as requested

---

## Summary

| Action | Cost | Time | Value for Procurement |
|--------|------|------|----------------------|
| Common Sense Education | Free | 4-8 wk | High — public rating |
| 1EdTech Contributor | Free | 1-2 wk | Medium — directory listing |
| HECVAT Lite | Free | Done | High — handed to district IT |
| NDPA signing | Free | Per-deal | Required — unblocks contracts |
| ~~iKeepSafe~~ | ~~$12K~~ | ~~Deferred~~ | Not a bottleneck |
| ~~SOC 2 Type II~~ | ~~$20K+~~ | ~~12 mo~~ | Enterprise only — post-funding |

Total cost to substantially close the gap from startup to "procurement-ready for mid-market K-12": **$0**.
