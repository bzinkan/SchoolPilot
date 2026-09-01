# ClassPilot control-authority lock order

The current production-compatible row/advisory lock order is:

1. school entitlement and teaching-session lifecycle advisory locks, when the
   caller owns either outer boundary;
2. sorted `classpilot:student-control:<school>:<student>` transaction advisory
   locks;
3. the destination student row during session issuance;
4. sorted device rows when exact binding revalidation is required;
5. exact student-session rows; and
6. the teaching-session or supervision-context row when that workflow needs it.

This order is shared by heartbeat/session-lease refresh, exact-bound delivery,
student-session transfer, class/coverage ownership transitions, roster resync,
class finalization, and persistent command authoring. PostgreSQL fan-out happens
only after the authority transaction commits.

The Waypoint-safe SSO design originally requested a session-first order before
sorted student/binding locks. That order cannot be introduced in only the new
command path: heartbeat and transfer already hold the student-control advisory
lock before device and student-session rows, while resync/finalization also
participate in the student-control-to-teaching-session order. Persistent class
and Coverage authoring follow that same sequence: discover candidate bindings
under the student-control lock, lock their device rows in sorted order, lock
the exact session rows, and only then lock the teaching/supervision row.
Inverting one writer would create a cycle with those deployed writers.

Moving to a session-first order therefore requires one coordinated migration
of every writer above, concurrency tests with old and new API tasks, and a
deployment boundary that prevents mixed lock orders. Until that migration is
performed, new SSO delivery work must preserve the production-compatible order
and deterministic sorting. The contract test fails if any of the relevant
paths silently invert only part of this sequence.
