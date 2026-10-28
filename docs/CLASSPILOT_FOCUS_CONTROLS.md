# Teacher Focus controls

Focus is the teacher-facing name for the website or resource restriction
previously called Waypoint. It uses the existing `lock-screen` command and
`screenLock` state. It does not start the retired persistent foreground-tab
feature represented by `focus-tab` and `restrictions.focus`.

## Teacher behavior

The Dashboard's Focus action reviews explicit students and a destination.
Each student's current page restricts that student to their current website.
A specific domain or URL can use **Entire website**, or **This resource only**
when supported. The resource preview defines the actual item or Section; an
unsupported or offline recipient never receives a broader website fallback.
The student tile's open padlock starts current-website Focus directly for that
student and requires a fresh HTTP(S) page.

**Stop Focus** is one action. It clears the destination restriction and any
remaining tab Focus from earlier controls. It preserves Flight Paths, block
lists, Attention, and tab limits. Remove Flight Path and an automatic preset's
Turn off for this session remain separate actions. The toolbar and tiles no
longer offer Clear Waypoint, Stop Both, or creation of persistent tab Focus.

Manage Tabs retains **Bring Forward** beside each current opaque tab. It
activates that tab once without starting a restriction or repeatedly returning
the student to it. Duplicate URLs do not identify a tab. The command uses
explicit students, opaque tab references, and observed revisions, partitioned
by current teaching or claimed-context authority. Existing restrictions still
apply to the requested tab.

Classroom assignments and Open URL continue to open only the selected link.
Teachers choose Focus separately when a destination restriction is intended.

## Command and cleanup compatibility

Focus retains the established `lock-screen` payloads, scope previews, precise
resource capability gates, and sign-in pass-through behavior. Current-page
Focus requires fresh telemetry; a saved website destination may use the
existing eligible signed-out delivery path. Current-page and precise-resource
actions must not be widened or substituted for unavailable students.

The unified Stop Focus action uses `unlock-screen { screenOnly: true }`. The
canonical server state change also clears retired `restrictions.focus`,
including restorable state, without deleting an independent Flight Path.
Offline cleanup stays pending until the browser receives the newer state or
the existing restriction expires. The screen-only capability and exact current
authority checks remain in force.

Retain the legacy `stop-focus` cleanup command and strict empty
`command.data: {}` for compatible old clients and saved tab Focus. Command IDs
remain in the envelope. New teacher requests cannot create `focus-tab` or an
`open-tab` Focus continuation. Existing persisted tab Focus, its lifecycle
reporting, cleanup, and expiry remain readable; do not rename stored fields or
reuse their meaning for destination Focus.

Bring Forward still requires accepted `scopedAuthorityChecksV1` and
`focusTabV1`, current telemetry, and an exact tab reference. Removing persistent
tab Focus from the workflow must not disable that shared capability. Raw
extension advertisements cannot override capability withdrawal. Observe has no
classroom commands.

## Outcomes and release boundary

Desired state is requested, not confirmation. Received acknowledgements remain
pending, and partial results identify the students still awaiting cleanup or
requiring a retry. A stale callback cannot relabel a replacement assignment or
clear its controls. Authority changes cancel remaining work.

This teacher workflow can ship in the SchoolPilot API/web release using the
existing extension protocol. ClassPilot 2.9.7 still displays student
notifications such as **Waypoint Set** and **Screen Unlocked**. Matching those
notification labels requires a separately reviewed extension release; this
change does not upload or publish one. Historical tab Focus wire behavior is
documented in `CLASSPILOT_FOCUS_BRING_FORWARD_CONTRACT.md`.
