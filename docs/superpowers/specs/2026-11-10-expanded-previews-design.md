# Clear expanded student previews

## Intent and authorization

Teachers need to read text when they open a student's tile. The existing viewer enlarges the grid's 640-pixel thumbnail, and numeric zoom is relative to the viewport. On November 10, 2026, the operator approved higher-resolution captures only for an open preview, native-size zoom, implementation in both repositories, CI, merge, SchoolPilot deployment and branch cleanup. The operator confirmed that extension 3.0.5 has not been submitted; retain that candidate version. Store upload is separate.

## Design

Keep routine JPEG50 captures, 640-pixel thumbnails, reference/delta transport and grid caches unchanged. A visible expanded browser preview requests a separate student-scoped detail lease. Capture a separate JPEG90 image at native resolution up to 1920 pixels wide, no more than once every five seconds. This is a still-image preview, never retired Live View or safety evidence.

`POST /api/classpilot/tiles/detail-preview` accepts `studentId`, `viewerInstanceId` and the existing teaching-session or supervision-context read authority, including its revision where applicable. It renews a viewer's one selected exact binding and returns a separately stored detail image or null. The response includes `detailPreview: { leaseId, expiresInSeconds, renewAfterSeconds }`. Leases and detail images last at most 20 seconds; the visible frontend polls every five seconds. `POST /api/classpilot/tiles/detail-preview/release` accepts the actor-bound `viewerInstanceId` and opaque `leaseId` for cleanup. Several authorized viewers may share one exact binding's capture lease.

The existing tracking-window screenshot policy may add `detailPreview: { mode: 'selected_student', leaseId, expiresInSeconds, intervalSeconds: 5, maxWidth: 1920, jpegQuality: 90 }`. This is an additive policy for clients that already negotiated scoped authority, tracking-window leases and active observation cadence. It cannot grant capture independently of those existing gates. Detail uploads use the existing device screenshot route with `captureKind: 'detail_preview'` and `detailPreviewLeaseId`, preserving all normal capture-time, entitlement, exact binding and current authority checks. They never update thumbnail/reference/delta stores.

The viewer keeps a thumbnail while detail is unavailable, atomically decodes replacements, and derives timestamps from the displayed image. It releases detail on close, hide, source or context change, and ignores late results. Numeric zoom uses decoded image dimensions; 100% means one image pixel per CSS pixel. Fit stays bounded by the viewport. Existing Windows/native source selection keeps its current behavior.

When no grant can be returned, `detailPreviewStatus: 'unsupported'` identifies a permanently unsupported client/authority, while `'unavailable'` identifies transient missing realtime or observation state. The visible viewer retries temporary failures every five seconds. All in-flight renewals retain generation-fenced late lease cleanup, including renewals that finish after close. Detail pixel acquisition is serialized with routine capture, but detail encoding/upload must not hold the grid's native capture lock.

Detail uploads use a separate bounded per-device admission budget so they cannot consume the ordinary screenshot lane's existing 60-per-minute allowance during rapid navigation. Do not raise ordinary screenshot or shared-NAT/WAF limits for this feature.

## Approaches

- Raise all screenshot resolutions: simplest but increases fleet bandwidth and grid payloads; rejected because the grid should stay lightweight.
- Sharpen or enlarge the existing thumbnail: cannot restore text discarded by downscaling; rejected.
- Separate short-lived detail capture for the selected student: approved approach, preserving grid traffic and isolation at the cost of an additive API/extension contract.

## Constraints and release

Teacher requests and responses contain no device IDs. Missing targets never broadcast. Existing owner/Observe, reporting, tracking, student session, school and control-revision checks remain authoritative. Redis failures fail closed. No schema, retention expansion, runtime capability activation, safety evidence reuse or new dependency is intended. Old extensions continue displaying their ordinary thumbnails.

Detail capture supports the extension's existing teaching-session and supervision-context authorities. Administrator Observe of those live authorities retains its existing read permission. Report-only observation under `student_session` remains a standard preview: candidate 3.0.5 does not implement the separate read-only observation capability/cadence, so the server must not grant detail demand there. Windows browser and native desktop source paths also retain their current preview behavior.

Detail capture timestamps use the server-time offset from the current policy receipt, allowing the detail store to enforce its short lease despite modest device clock skew. Routine screenshot timestamps are unchanged. Frontend detail pixels independently expire within 20 seconds rather than inheriting the standard image's 120-second reconnect retention.

Use clean worktrees based on current main, preserving unrelated primary-checkout edits. Review both implementations, run the required local gates and exact-commit CI, then merge. Deploy compatible SchoolPilot API/worker before frontend through the documented guarded procedure. Package the final clean ClassPilot 3.0.5 source and verify its actual archive. Preserve the previous unsubmitted candidate bytes and receipt before delivering the revised candidate. No Chrome Web Store upload or managed-device adoption is claimed.
