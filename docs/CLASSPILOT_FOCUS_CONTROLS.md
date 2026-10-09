# Teacher Focus controls

Manage Tabs exposes Bring Forward and Focus beside each current opaque tab.
Bring Forward requests one activation; Focus persists until stopped or its
server/extension lifecycle invalidates the target. Duplicate URLs do not
identify a tab. Each command names explicit students and sends only their tab
reference and observed revision. Claimed-context delivery partitions those
exact rows by the currently authorized context.

Focus holds the selected browser tab in the foreground; it does not restrict
navigation within that tab. Waypoints and Flight Paths retain their independent
destination restrictions. The student tile's open padlock now focuses that
student's current exact tab. A closed padlock stops Focus when only Focus is set,
or clears the Waypoint when only a Waypoint is set. When both are set, the padlock
opens a menu with Stop Focus, Clear Waypoint and Stop Both. Tooltips identify the
current action, and pending or suspended states never claim confirmed enforcement.

Stop Both waits for the Stop Focus result before clearing the Waypoint. If Focus
confirmation is still pending after 60 seconds, Waypoint clearing remains a
separate retry. Partial results identify the control that remains. Either release
leaves Flight Paths, block lists, Attention and tab limits unchanged. Changes to
the classroom authority or authenticated student binding cancel remaining work.

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
