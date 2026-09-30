# ClassPilot 2.10.0 contract: precise restriction resources

This is the extension contract for `preciseRestrictionResourcesV1`: "This resource only" Waypoints and Flight Paths that allow a
single YouTube video, Google Doc, Slides deck, Sheet, Form or Drive file, or one section of a site. It is written for the ClassPilot
extension work (repository `bzinkan/ClassPilot`), which happens separately. Everything stated as a server fact below is implemented
in SchoolPilot (roadmap PR 2) and covered by its tests; everything stated as an extension requirement is what 2.10.0 must do.

Status: server side implemented and AUTOMATED-TEST VERIFIED, capability default off. ClassPilot 2.10.0 ships only after the server
PRs 2 through 5 are merged and deployed. The precise pilot profile stays refused until it is bound to the exact 2.10.0 release
evidence (see [Activation](#10-activation-and-release-gates)).

## 1. What the server guarantees

- A precise restriction reaches only an exact student/session/device binding whose current negotiation **accepted**
  `preciseRestrictionResourcesV1`. The server never reads the raw advertisement for this decision (the realtime cache keeps only
  32 raw capabilities).
- Every other binding gets the **whole** classroom state withheld (`classroomState: null`, `withheldReason:
  "precise_restriction_capability_required"`). The server never sends a partial state, never drops the precise fields, and never
  degrades a section or resource to its hostname.
- Presence rule: any `screenLock.resource` or `flightPath.resources` key in a stored state marks it precise, whatever its value.
  If a stored entry no longer re-validates, the state is withheld from everyone.
- A precise command frame (`lock-screen` or `apply-flight-path`) is always sent with its `classroomState`, is exact-bound
  (`exactBinding.bindingVersion: 2`) and lists `preciseRestrictionResourcesV1` in `requiredCapabilities`. The server never sends
  a bare precise frame and never broadcasts one.
- Targets that cannot take a precise restriction get no desired state at all (so no legacy projection exists): an online
  target without the accepted capability is marked unavailable with `Unsupported client: preciseRestrictionResourcesV1 is required`;
  an offline target is never deferred for later delivery.
- Teachers see `enforcementHealth: "unsupported"` with `Extension update required for this Waypoint or Flight Path` for a
  student whose client cannot take the restriction.
- Website-only Waypoints and Flight Paths are byte-for-byte unchanged (golden fixture
  `tests/fixtures/classpilot-compatibility/schoolpilot-legacy-restriction-frames.json`).

## 2. Capability and negotiation

| Item | Value |
| --- | --- |
| Capability | `preciseRestrictionResourcesV1` |
| Server registry position | index 25 of `CLASSPILOT_PROTOCOL_V3_CAPABILITIES` (26 entries) |
| Server feature flag | `CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1` (default `false`) |
| Rollout registry | `CLASSPILOT_CAPABILITY_ROLLOUTS_JSON` entry, written only by the guarded profiles `precise-restriction-resources-pilot` / `-off` |
| Dependencies | protocol v3 and accepted `scopedAuthorityChecksV1` (scoped-authority dependent). No dependency on `restrictionAuthPassThroughV1` (see section 8) |
| `CLIENT_PROTOCOL_VERSION` | stays `3` |
| `CLASSROOM_STATE_SCHEMA_VERSION` | stays `1` (the fields are additive) |

Negotiation is unchanged in shape: on the registration, heartbeat and websocket-auth surfaces the client sends
`clientProtocolVersion: 3` and `extensionCapabilities`; the server answers `acceptedCapabilities` = advertised capabilities that
the server enables for the school, with the scoped-authority dependency applied.

Extension requirements:

- Append `preciseRestrictionResourcesV1` to `EXTENSION_CAPABILITIES` and to `SCOPED_AUTHORITY_DEPENDENT_CAPABILITIES`
  (service-worker.js; 2.9.6 has them at :315-348 and :349-365). Gate every use on the negotiated set
  (`hasNegotiatedCapability`), never on the advertisement. Pin it in the containment loop of `extension-release.test.ts`.
- Renegotiation happens on every hello. When the capability is no longer accepted:
  - Do not apply precise fields from any newly received snapshot. Treat a snapshot that carries them as unsupported
    (ACK `unsupported`, keep the prior state). Never strip the fields and apply the rest.
  - Keep enforcing an already applied precise restriction until a newer revision replaces it or its `hardExpiresAt` passes. The
    server withholds precise states from that binding, so the next state you receive is the one that ends it.

## 3. Wire shapes

```ts
type AllowedResource =
  | { type: "website";  hostname: string; includeSubdomains: true }
  | { type: "section";  hostname: string; includeSubdomains: false; pathPrefix: string }
  | { type: "resource"; hostname: string; includeSubdomains: false;
      provider: "youtube" | "google_docs" | "google_slides" | "google_sheets" | "google_forms" | "google_drive";
      resourceId: string; canonicalUrl: string };

restrictions.flightPath = { active: true, allowedDomains: string[], name?: string, resources?: AllowedResource[] };
restrictions.screenLock = { active: true, url: string, resource?: AllowedResource /* section or resource only */ };
```

Rules the server follows when it sends them:

- `flightPath.allowedDomains` keeps its existing meaning: website hosts, each including subdomains. Website entries always travel
  here, exactly as today.
- `flightPath.resources` holds only `section` and `resource` entries, 1 to 200 of them, and is present only on an active Flight
  Path. The extension must still accept a `website` entry in `resources` (host plus subdomains), because the type allows it.
- `screenLock.resource` is always a `section` or `resource`, never a `website`; `screenLock.url` then equals
  `canonicalUrlForResource(resource)`: the resource's `canonicalUrl`, or `https://<hostname><pathPrefix>` for a section.
  The URL can carry a query (`https://www.youtube.com/watch?v=<id>`).
- Inactive objects never carry the keys: `{ active: false }` and `{ active: false, allowedDomains: [] }` are the only inactive shapes.
- The "Entire website" Waypoint stays `{ active: true, url }` exactly as today.
- Command data mirrors the snapshot: `lock-screen` `data: { url, resource }`; `apply-flight-path`
  `data: { flightPathId, flightPathName, allowedDomains, resources }`. The frame's `classroomState` is authoritative. Never
  apply a precise command payload without its classroom state.

Example snapshot fragments:

```json
{ "screenLock": { "active": true, "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "resource": { "type": "resource", "hostname": "youtube.com", "includeSubdomains": false, "provider": "youtube",
                  "resourceId": "dQw4w9WgXcQ", "canonicalUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } } }

{ "flightPath": { "active": true, "name": "Moon phases", "allowedDomains": ["khanacademy.org"],
    "resources": [
      { "type": "section", "hostname": "nasa.gov", "includeSubdomains": false, "pathPrefix": "/solar-system" },
      { "type": "section", "hostname": "classroom.google.com", "includeSubdomains": false, "pathPrefix": "/c/NjE2MzQ1Njc4" } ] } }
```

Extension requirements:

- `normalizeRestrictions` (core, 2.9.6 :577-647) parses `resources` and `resource` with the ported validator. If any entry is
  out of contract, reject the **whole** snapshot: ACK `failed` with the new error code `PRECISE_RESTRICTION_INVALID` (add it to
  `COMMAND_DIAGNOSTIC_MESSAGES`) and keep the prior state. Never drop an entry: dropping a Waypoint resource would turn it into a
  domain lock.
- Relax both "active Flight Path requires at least one domain" throws (core :607-609 and :1416-1424) to
  `allowedDomains.length + resources.length > 0`. The landing target of a resource-only path is
  `canonicalUrlForResource(first resource)`.
- `safeRestrictionTarget` (core :1049-1068) accepts a query only when `screenLock.resource` is present and
  `isUrlAllowedByResource(url, resource)` is true.

## 4. Normative matcher

The matcher is `isUrlAllowedByResource` in `src/services/restrictionResources.ts`. Port it verbatim together with
`extractRestrictionResourceIdentity` and `validateAllowedResource`; skip only the public-suffix check, which the server applies
before anything is stored.

**Shared case file**: `tests/fixtures/restriction-resource-matcher-cases.json` (schema version 1, LF line endings enforced by
`.gitattributes`). SHA-256:

```text
b6ca97bae37c7d1fffd11960699e749697a64c74ed5b6db5679d2f2a1bc2372b
```

Copy the file byte for byte, pin the same SHA-256 in the extension tests, and assert every row in
`extension-classroom-runtime.test.ts`. Sections: `identity` (43 rows, `extractRestrictionResourceIdentity`), `match` (65 rows,
`isUrlAllowedByResource` against the named `resources`), `validate` (28 rows; skip the two `serverOnly` public-suffix rows),
`normalize` and `legacyHostProjection` (server authoring rules, recorded so the extension knows what it can receive) and
`ruleCount` (the DNR budget below). A change to any rule changes the file and its hash in both repositories together.

Rules:

1. **Host form.** Parse with `new URL()`. Compare `hostname` lower-cased, with one trailing `.` and then one leading `www.` removed.
   Anything that does not parse is not allowed. A URL with a username or password is never allowed.
2. **website**: `http:` or `https:`; the host equals `hostname` or ends with `.` + `hostname`.
3. **section**: `https:` only, default port only, host equal to `hostname` (no subdomains), and `pathname === pathPrefix` or
   `pathname` starts with `pathPrefix + "/"`. Case-sensitive. Query and fragment are ignored. `/class` does not allow
   `/classified`.
4. **resource**: `https:` only, default port only, and the URL's identity equals `(provider, resourceId)`:
   - YouTube hosts `youtube.com`, `m.youtube.com`, `youtube-nocookie.com` (after rule 1): `/watch` with **exactly one** `v`
     parameter (decoded) matching `^[A-Za-z0-9_-]{11}$`, or a path `^/(shorts|embed|v|live)/<id>(/.*)?$`. `youtu.be`:
     path `^/<id>/?$`. Other videos, the home page, search, channels and `music.youtube.com` never match.
   - `docs.google.com`: path
     `^/(u/[0-9]{1,2}/)?(document|presentation|spreadsheets|forms)/(u/[0-9]{1,2}/)?d/(e/)?<id>(/.*)?$`, id
     `^[A-Za-z0-9_-]{20,128}$`. `?authuser=` is ignored. The published `e/` id is part of `resourceId`, so a Form's edit id and
     its published id are different resources.
   - `drive.google.com`: `^/(u/[0-9]{1,2}/)?file/(u/[0-9]{1,2}/)?d/<id>(/.*)?$`, or `/open` / `/uc` (optionally after `/u/N`)
     with exactly one `id` parameter.
   - Resource ids are case-sensitive.
5. **Validation** of a received entry: exact key sets per type (no extra keys); a syntactically canonical hostname (lower case,
   no `www.`, no trailing dot, at least two labels, no numeric final label); `website` has `includeSubdomains: true`, `section`
   and `resource` have `false`; `pathPrefix` is 2 to 512 characters, starts with `/`, has no trailing `/`, no `//`, no `?`, `#`,
   `\` or whitespace, and survives URL normalization unchanged; a resource's hostname is its provider's host (`youtube.com`,
   `docs.google.com`, `drive.google.com`), its id matches the provider pattern (Docs family ids may carry the `e/` prefix), and
   `canonicalUrl` equals the recomputed canonical URL:

   | Provider | Canonical URL |
   | --- | --- |
   | youtube | `https://www.youtube.com/watch?v=<id>` |
   | google_docs / google_slides / google_sheets | `https://docs.google.com/<document\|presentation\|spreadsheets>/d/<id>/edit`; published `e/` ids end in `/pub` (`/pubhtml` for Sheets) |
   | google_forms | `https://docs.google.com/forms/d/<id>/viewform` |
   | google_drive | `https://drive.google.com/file/d/<id>/view` |

6. **Lists**: at most 200 entries, no two with the same identity, rule count within the budget below, serialized size at most
   49,152 bytes. One bad entry invalidates the list.

What the server does before anything reaches the extension (for reference): `forms.gle` links are resolved at save time, and
unresolvable ones are refused; Google Classroom links become sections (`/c/<course>` or `/c/<course>/a|m/<post>`, with `/u/N`
dropped); a link on a YouTube, Docs or Drive host that does not identify one item is refused; other page links become sections,
and a page that depends on a query is refused; a bare site becomes a website entry.

## 5. DNR rules

All rules are `resourceTypes: ["main_frame"]`, in the existing classroom range `[1, 1000)`, so a 2.9.x rollback clears them with
the range it already owns. No new range.

| Situation | Rules |
| --- | --- |
| "This resource only" Waypoint | id 1: block all, priority 500, no exclusions. Ids 3 and up: one allow per rule shape of the resource, priority 500 (allow wins the tie). Id 2 (the domain-Waypoint allow) is unused. |
| Flight Path with `resources` | id 1: block, priority 1, `excludedRequestDomains: allowedDomains` (omit the key when `allowedDomains` is empty). Ids 3 and up: one allow per rule shape of each section or resource, priority 2. Website entries found in `resources` join `excludedRequestDomains`. |
| Domain Waypoint or website-only Flight Path | unchanged |

While a Waypoint is active the Flight Path's rules are not installed (the overlay rule of today), so ids 3..999 serve one of them.

**Rule-ID budget.** Rules per entry: website 0, section 1, resource 1, YouTube 2. The sum over a list must be at most 997 (ids
3..999). The server enforces this when a Flight Path is saved (`RESOURCE_RULE_BUDGET_EXCEEDED`). `buildDnrRules` must assert it
again and throw before touching Chrome state, and a vitest must build a maximal list and check `isRuleInRange(id, "classroom")`
for every id.

**Shapes.** Use anchored `regexFilter` rules with `isUrlFilterCaseSensitive: true`. Do not use `||host/path` `urlFilter`
substrings: they match `/classified` for `/class`, any longer id, and subdomains. Do not use `^`-separator `urlFilter`s for
sections either: `^` also matches `~`, `!`, `,` and similar characters, so `/class^` would allow `/class~x`. Reference patterns
(RE2, no lookaround; `E()` escapes regex metacharacters):

```text
section   ^https://(?:www\.)?E(hostname)E(pathPrefix)(?:[/?#]|$)
docs      ^https://(?:www\.)?docs\.google\.com/(?:u/[0-9]{1,2}/)?<document|presentation|spreadsheets|forms>/(?:u/[0-9]{1,2}/)?d/E(resourceId)(?:[/?#]|$)
drive     ^https://(?:www\.)?drive\.google\.com/(?:u/[0-9]{1,2}/)?file/(?:u/[0-9]{1,2}/)?d/E(resourceId)(?:[/?#]|$)
youtube   ^https://(?:(?:www\.)?(?:m\.)?youtube\.com|(?:www\.)?youtube-nocookie\.com)/(?:(?:shorts|embed|v|live)/ID(?:[/?#]|$)|watch\?(?:P&)*v=ID(?:&P)*(?:#.*)?$)
youtu.be  ^https://(?:www\.)?youtu\.be/ID/?(?:[?#].*)?$

P (a query parameter whose decoded name is not "v"):
          (?:[^v%&#=][^&#]*|v[^=&#][^&#]*|%(?:[^7&#][^&#]*|7(?:[^6&#][^&#]*)?)?|=[^&#]*)?
```

The DNR layer may be narrower than the matcher, never broader. Checked against every `match` row of the case file plus
adversarial URLs (`watch?v=OTHER&v=ID`, `watch?v&v=ID`, `watch?%76=OTHER&v=ID`, `/solar-system~x`, a longer id, a subdomain, a
port, credentials), these patterns allow nothing the matcher rejects. They are narrower in three places, all acceptable because the
landing URL stays allowed: Drive `open?id=` / `uc?id=` links, a percent-encoded video id, and a trailing-dot host. Run the same
comparison in the extension's DNR vitest.

**Regex budget.** Count every regex rule: the auth pass-through (`restrictionSso`, at most 144) plus classroom resources. If the
total would exceed 800, ACK `failed` with the new code `DNR_REGEX_BUDGET_EXCEEDED` (add it to `COMMAND_DIAGNOSTIC_MESSAGES`) and
keep the prior state. Call `chrome.declarativeNetRequest.isRegexSupported` once per shape at startup and fail closed if a shape
is unsupported. With the server's 200-entry cap a Flight Path needs at most 400 regex rules and a Waypoint 2.

## 6. Unified precedence

One pure `decideNavigation(url, policy)` in the core, used by `buildDnrRules`, `handleBeforeNavigateForPolicy`, the history
listeners and `createdTabPolicyDecision`. The order is the DNR order that 2.9.x already enforces:

1. attention mode (2000)
2. school block list (1000)
3. teacher block list (800; it stays 800)
4. auth pass-through for sign-in (600 allow; a teacher block covering an auth host is re-asserted at 700)
5. Waypoint, domain or resource (500)
6. temporary allow (100 while a Waypoint or Flight Path is active)
7. Flight Path: websites, sections and resources (block 1, precise allows 2)

Full pairwise table (row and column both match the URL; the cell names the layer that decides):

| | attention | school block | teacher block | auth pass-through | Waypoint | temporary allow | Flight Path |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **attention** | - | attention | attention | attention | attention | attention | attention |
| **school block** | attention | - | school block | school block | school block | school block | school block |
| **teacher block** | attention | school block | - | teacher block | teacher block | teacher block (with a Waypoint or Flight Path active); temporary allow otherwise | teacher block |
| **auth pass-through** | attention | school block | teacher block | - | auth pass-through | auth pass-through | auth pass-through |
| **Waypoint** | attention | school block | teacher block | auth pass-through | - | Waypoint | Waypoint |
| **temporary allow** | attention | school block | see teacher block row | auth pass-through | Waypoint | - | temporary allow |
| **Flight Path** | attention | school block | teacher block | auth pass-through | Waypoint | temporary allow | - |

Notes:

- "Waypoint" includes a resource Waypoint: its allow is a Waypoint-layer allow, so a teacher block still wins (decision 2 of the
  roadmap plan) and a temporary allow cannot escape it.
- 2.9.x's JavaScript listener returns early for the screen lock and lets the Waypoint beat the teacher block, while DNR already
  blocks. 2.10.0 aligns the listener with DNR. Release-note it.
- The temporary-allow row keeps today's two DNR priorities (900 with no destination restriction, 100 with one). Publish this
  table in the extension's `SCHEDULED_CLASSROOM_PROTOCOL.md` and assert it pair by pair in vitest, both for `decideNavigation` and
  for the DNR priorities, including the teacher-block 800 pin.

## 7. SPA enforcement

DNR sees only network navigations. Precise restrictions also need the in-page ones:

- Register `chrome.webNavigation.onHistoryStateUpdated`, `onReferenceFragmentUpdated` and `onCommitted` (transition qualifier
  `forward_back`, and prerender activation) synchronously at the top level of the service worker, like `onBeforeNavigate`
  (2.9.6 SW :23566), so a sleeping worker is woken by them. Pin the registration with a source-text test.
- Filter to `frameId === 0`, run `decideNavigation`, and on a block call `chrome.tabs.update(tabId, { url: target })` where
  `target` is the Waypoint URL, else the first Flight Path landing target.
- Loop guard: at most one policy redirect per tab per 1000 ms. Cover YouTube playlist autoplay (`&list=` advancing to another video
  through `pushState`) in the harness.
- Report a block caused by a section or resource entry with `policySource: "resource"`. Add it to `POLICY_SOURCES` (core :63-70).
  The server accepts it from this release on.
- Startup reconciliation clears stale classroom-range rules (dynamic rules persist across a browser restart). The DNR
  backup/restore struct (2.9.6 SW ~:18920-18928) must carry `resources` and `resource` (and `focus`, section 12).

## 8. Sign-in

Server facts:

- When the school's sign-in-safe gate (`restrictionAuthPassThroughV1` rollout plus an enabled SSO policy) is active, every active
  Flight Path and every URL Waypoint, precise or not, is sign-in relevant. A binding that did not accept
  `restrictionAuthPassThroughV1` gets the state withheld (`restriction_auth_update_required`). A binding that did gets the state
  with `authPassThroughPolicyRevision` and the pass-through envelope.
- When the gate is off, the state is delivered without a sign-in envelope, exactly as for a website Waypoint today.
- Precise delivery never depends on `restrictionAuthPassThroughV1` being negotiated. Those two outcomes are the defined outcome
  for a 2.10.0 client without it.

Extension requirements:

- A resource Waypoint on a signed-out Chromebook must reach the document through the auth pass-through rules (600 beats the
  Waypoint's block-all at 500) and land on `canonicalUrl`. Add harness cases to `test-extension-portal-first.mjs` and the new
  precise harness.
- Without a delivered pass-through envelope, do not invent sign-in exemptions: a signed-out student stays blocked on the sign-in
  host, and the harness asserts it.

## 9. Persistence and downgrade

- A 2.9.x core that restores a persisted precise snapshot drops `resource` and derives a domain lock from `url`. So 2.10.0 must
  persist precise screen locks and Flight Paths under `classroomControlStateV1` in a form a 2.9.x restore rejects (a schema marker
  the old restore refuses, or no legacy-readable `url`/`domain` for a precise Waypoint). A downgrade then restores no precise
  restriction instead of a wider one. The server withholds precise states from a 2.9.x binding and shows the teacher
  "unsupported".
- Extend `test-extension-recovery-red-on-old.mjs`: load a 2.10.0-written snapshot into the 2.9.6 core and assert there is no
  domain-wide DNR rule.
- Server-side counterpart: the PR 2-pre fence (#550) withholds precise states in every older image, and the rollout runbook
  (`docs/CLASSPILOT_ROADMAP_RUNTIME_ROLLOUT.md`) clears stored precise restrictions before an image rollback.

## 10. Activation and release gates

- Server: deploy the image with this PR (capability off), then server PRs 3 to 5, before 2.10.0 is published.
- The runtime tool refuses `precise-restriction-resources-pilot` until a reviewed server change binds the exact 2.10.0 tag, merge
  SHA and ZIP SHA-256. That needs a clean tag, green harnesses in CI, and MANAGED-CHROMEBOOK VERIFIED on at least two
  Google-Admin-managed devices before the Web Store upload.
- The dashboard's `features.preciseRestrictionResources` flag is for SchoolPilot's UI only. The extension keys on negotiation alone.

## 11. Required extension tests

- New `scripts/test-extension-precise-resources.mjs`: apply a classroom state with resources, assert DNR ids `[1, 3, 4, ...]`
  and priorities, drive `handleBeforeNavigateForPolicy` and the history listener with stubbed effects, and cover the regex-budget
  failure ACK. Chain it in `package.json` and in `verify-extension-package.mjs` `runPackagedTests`.
- Extend the lifecycle harnesses with precise cases:
  - `worker-recovery`: worker killed with a resource Waypoint active, woken by an SPA navigation, blocked.
  - `resilience`: a WebSocket reconnect re-delivers without duplicate rules.
  - `authority-races`: a stale revision carrying resources is rejected.
  - `reload-authority` and `auth-startup`: a browser restart reconciles dynamic rules with the restored snapshot; sign-out
    clears classroom-range rules.
  - `scheduled-classroom`: a transition clears or replaces resources.
  - `2-7-behavior`: the existing identity-race run still passes with precise states in play.
  - Handoff: student B inherits no student-A rules.
  - Capability withdrawn on re-hello (section 2).
  - Red-on-old (section 9).
- Vitest: the case file with its pinned SHA-256; DNR shapes, priorities and boundary negatives compared with the matcher; the
  rule-ID budget; `normalizeRestrictions` accepts resources, rejects a snapshot with any invalid entry, and still drops unknown
  keys; a resource-only Flight Path no longer throws; the `decideNavigation` table; the teacher-block 800 pin.

## 12. Focus and Bring Forward (PROVISIONAL)

This section is provisional. The server side belongs to later roadmap PRs (Focus and Bring Forward, PR 5 in the current plan), and
that PR defines the final wire shape. Do not build against it before that PR merges.

- Capability `focusTabV1`, negotiated and scoped-authority dependent like the one above.
- `restrictions.focus?: { active: true, tabRef, url, source: "teacher" | "presentation", setAt } | { active: false }`. Resolve
  `tabRef` with `tabSnapshotV1`. Watch `tabs.onActivated`, `windows.onFocusChanged`, `tabs.onRemoved` and `tabs.onUpdated(url)`,
  and re-activate the tab at most every 2000 ms. Skip sign-in and auth tabs. Invalidate with `focus_tab_closed` or
  `focus_tab_off_policy`, reported through a `classroom-state-ack` extra `focus: { state, reason }`. Restrictions always beat
  Focus. Persist it with the snapshot and re-resolve it on wake.
- Bring Forward: transient `activate-tab { tabRef, observedRevision }`. Without `focusTabV1`: ACK `failed`
  `TAB_ACTIVATE_CAPABILITY_REQUIRED` `{ status: "unsupported" }`. Unknown or changed tab: `STALE_TAB_REF`
  `{ status: "stale_tab_ref" }`. Success: `{ status: "activated", tabRef, tabSnapshotRevision }`.

## 13. Version and documentation

Version `2.10.0` in `extension/manifest.json`, `server/__tests__/extension-release.test.ts` and
`scripts/verify-extension-package.mjs`. Update the documentation pins (`extension-sso-documentation.test.ts`, `extension/README.md`,
`extension/COMPLIANCE.md`: persistent restriction targets may now carry a teacher-chosen resource identifier such as a video id),
add `CLASSPILOT_2_10_0_RELEASE.md`, and add "Precise restriction resources" and (later) "Focus tab" sections to
`SCHEDULED_CLASSROOM_PROTOCOL.md`. No Web Store publish happens in a PR.

## Server references

- Wire contract and matcher: `src/services/restrictionResources.ts`; `forms.gle` resolver: `src/services/restrictionResourceResolver.ts`.
- Delivery, withholding and health: `src/services/classpilotClassroomState.ts` (`classpilotPreciseRestrictionPayload`,
  `serializeClasspilotStudentControlStateForDelivery`, `effectiveClasspilotControlEnforcementHealth`).
- Per-target dispatch gate and frames: `src/services/classpilotCommandDispatcher.ts`; socket guards: `src/realtime/ws-broadcast.ts`.
- Tests: `tests/restriction-resources.test.ts`, `tests/classpilot-precise-restriction-projection.test.ts`,
  `tests/classpilot-precise-restriction-dispatch.test.ts`, `tests/classpilot-precise-restriction-fence.test.ts`,
  `tests/classpilot-exact-binding-capability-delivery.test.ts`, `tests/classpilot-protocol-compatibility.test.ts`.
- Rollout, rollback and the registry guard: `docs/CLASSPILOT_ROADMAP_RUNTIME_ROLLOUT.md`.
