# Classroom assigned-material Focus implementation plan

The approved behavior is to permit all published Classroom links, including
outside sites, while keeping Classroom Focus active. The implementation uses
server-derived course source and an explicit whole-website review for outside
links. It does not infer trusted links from student navigation or submissions.

1. Reproduce the 3.0.6 single-domain Focus restriction and record the separate
   login and bulk Unfocus prerequisites.
2. Define one shared server/extension fixture and strict bounded scope validator;
   prove assigned websites/Google copies/video identities and blocked unrelated
   destinations before changing matcher behavior.
3. Read school-bound published course source and sign a short-lived review tied
   to exact class authority and students; refuse changed/expired source before
   command persistence.
4. Add the Dashboard course/scope review and stale-request fences. Keep ordinary
   Focus and Classroom Open regression coverage.
5. Carry the scope through authoritative state, exact command/Redis/socket
   delivery and independent teacher-intent attribution; preserve the underlying
   Flight Path when clearing Focus.
6. Implement extension matcher/DNR, restore/clear, capability withdrawal and
   schema-4 persistence. Validate actual Chromium enforcement in source and a
   byte-verified test package.
7. Add default-off guarded runtime configuration and a rollback inventory/clear.
   Run API checks, serial isolated-Postgres authority tests, required Dashboard
   gates, source/package extension suites, and independent cross-repo review.
8. Open draft reviewable PRs with exact validation and outstanding release gates.
   API deployment, Store release and managed adoption remain separate steps.

Detailed behavior, limits, release order and containment are in
[the feature runbook](../CLASSPILOT_CLASSROOM_FOCUS.md).
