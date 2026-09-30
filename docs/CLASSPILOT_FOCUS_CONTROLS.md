# Teacher Focus controls

Manage Tabs exposes Bring Forward and Focus beside each current opaque tab.
Bring Forward requests one activation; Focus persists until stopped or its
server/extension lifecycle invalidates the target. Duplicate URLs do not
identify a tab. Each command names explicit students and sends only their tab
reference and observed revision. Claimed-context delivery partitions those
exact rows by the currently authorized context.

New actions require accepted scopedAuthorityChecksV1 and focusTabV1, current
telemetry and an exact tab reference. Raw extension advertisements cannot
override capability withdrawal. Stop Focus uses the current explicit student
authority and an empty payload; it remains available for saved/offline Focus
cleanup when the capability is withdrawn. Observe has no classroom commands.

Received acknowledgements remain pending. The dialog shows each recipient's
result and updates it from the matching command's websocket projection. The
student's confirmed Focus status distinguishes active, Attention suspension,
authentication suspension and invalidation. A desired restriction alone is
shown as requested. Assignment changes close the old controls and discard late
results from the original command without claiming enforcement.

The server contract/backend, extension and interfaces remain separate reviewed
slices. Focus defaults off. Source/unit/browser checks do not establish exact
package or managed-Chromebook acceptance, deployment or activation. The later
Classroom action slice adds Open + Focus and reviewed Open as Lesson workflows.
