# Screenshot traffic and database efficiency, second pass

The operator requested continued implementation toward 2,000 online students
under $300/month, preserving features and performance, with no paid AWS load
testing. Earlier authorization covers both repositories and implementation
without further design approvals. This extends the November 9 design.

## Constraints

Keep all genuine captures, JPEG bytes/quality, 30/5-second screenshot rates,
ten-second heartbeat opportunities, history and retention. Preserve canonical
entitlement, RLS, exact binding, privacy/final-publication checks and HTTP recovery.
Do not cache authority or alter immutable migration definitions. No production
deployment, subscription, Terraform apply or Store publication is automatic.
Use Node 22 for SchoolPilot, Node 24 for ClassPilot, existing Windows/local
PostgreSQL/Redis/Chrome, and bounded synthetic fixtures only.

## Selected work

1. Origin gzip for authorized teacher screenshot JSON, level 1, bounded work
   and identity fallback. It removes Base64 transport overhead without changing
   image bytes. Compression finishes before the existing final authority check;
   changed authority cannot reuse a prepared pixel response. No other API/token
   responses are compressed. Cache policy remains private/no-store.
2. Reuse only the final safety-free educational/unknown classifications that
   the current classifier would return from its existing valid cache. Keep
   unsafe-search and provider-input checks in their existing order, TTL/model/
   input-policy boundaries, fresh teacher intent for non-educational results,
   and asynchronous safety handling. Persist every heartbeat; avoid redundant
   classification UPDATE/cache-patch/fan-out work when INSERT already contains
   the exact final fields. RETURNING remains the proof for the fast path.
3. Prove whether the single-column student/email heartbeat indexes are redundant
   with their composite leading-prefix counterparts. Use catalog checks and
   representative local EXPLAIN queries before a guarded retirement migration.
   Do not remove exact-binding history indexes, change retention or drop rows.
4. Investigate bounded lossless deltas on real local Chrome JPEG captures. Any
   implementation requires measured byte and CPU benefit, exact reconstruction,
   scoped bases and full-frame fallback; changing pages/video may save nothing.
5. Prepare a separately negotiated binary full-screenshot upload if the above
   measurement supports it: raw JPEG bytes plus bounded metadata, decoded into
   the same canonical operation. Keep the 256 KiB logical frame bound, stable
   operation IDs, JSON/HTTP fallback and unsupported-client compatibility.
   Any new capability must remain off and have governed scoped activation.

## Alternatives and limits

Lower capture rates, lower image quality, dropped history, stale authorization
caches and unreviewed edge subscriptions are excluded. Teacher WebSocket reads
can reduce request work but save much less than image-byte reduction on PAYG.
New native screenshot authority SQL may later reduce four network round trips
to one while retaining fresh internal statements; immutable v1 cannot be reused
blindly because current manual-class expiry rules have evolved.

The current PAYG all-moving-image scenario cannot be made less than $300 by
database optimization alone. Keep zero-reuse and eight-hour cases, uncertain
compute/storage costs and unavailable Pro compatibility explicit. No local
correctness or compression test constitutes AWS fleet-capacity acceptance.

## Measured lossless delta selection

The local Chrome spike used the real JPEG-50 capture and production 640px/q0.6
thumbnail function. Fifteen captures/20 comparisons reconstructed exact bytes in
Node and Chrome. Typing saved 92.9% (25,874 to 1,840 bytes), a caret-like change
99.4%, and a banner text change 82.7%; scrolling/noise saved under 6%. These are
controlled examples, not a school workload average. Encoder memory was about
1.2–1.5 MB; partial changes used about 1.6–2.2 ms CPU, decoder about 0.01–0.03 ms.

Implement deltas before a separate binary-full-image protocol. Use a bounded
copy/literal codec that can copy bytes starting at arbitrary base bit offsets;
it preserves the exact JPEG bitstream rather than decoding/re-encoding pixels.
Student encoding has an 8 ms budget, at most 65,536 dictionary entries and twelve
candidates/key; use a patch only if it saves at least 25% and 512 bytes. Base,
target and patch inputs are bounded by 256 KiB, and decode has at most 8,192
operations. Existing exact-image references win for identical captures.

The final encoder samples at most 16,384 words directly across eight bit
alignments, with a 65,536-head table and about 448 KiB of index arrays plus
inputs/output. It does not allocate seven shifted base images. Genuine Chrome
worksheet captures with this encoder produced about 91–92% smaller patches in
3.8/5.2/3.9 ms for the three measured edits. The earlier prototype's memory and
timing figures above describe the spike rather than this production codec.

The canonical TypeScript codec is generated verbatim to the frontend and separate
extension, with parity/golden/malformed-input tests. The extension sends a JSON
`screenshotDelta` instead of `screenshot` only under a new default-off capability
`scopedScreenshotDeltasV1`, requiring transport, references and their parents.
The descriptor is `{ codec: 'cp-bit-copy-v1', baseImageId, data, targetBytes,
uploadIntegrity }`; data is Base64 patch bytes. Upload integrity is SHA-256 over
the domain `classpilot:screenshot-delta-upload:v1\0`, opaque base ID, `\0` and
target raw JPEG bytes. It is server input only. Full/ref version 1 stays valid.

The server reads only the exact scoped current base under existing fresh upload
authority, bounded-decodes and verifies it, then atomically writes current full
pixels plus one profitable patch only if the expected base ID is still current
and fresh. Current full pixels stay compatible with older readers. Keep only one
patch, not a history chain or duplicate full image. Full writes clear patches.
Unknown, expired, raced or invalid bases return existing `SCREENSHOT_IMAGE_REQUIRED`;
the extension immediately sends the full bytes from the same genuine capture.

Teachers opt in with `imageDeltaProtocolVersion: 1` alongside existing known IDs.
Only a matching base ID/binding may receive `{ imageId, delta: { codec,
baseImageId, data, targetBytes, integrityTag }, ...freshMetadata }`. The public
integrity tag uses domain `classpilot:screenshot-delta-display:v1\0`, target
opaque image ID, `\0` and target bytes; it is not the private content hash or a
cross-scope fingerprint. The existing query cache is the only pixel base. A
missing/bad base or integrity mismatch triggers one full read with current
authority and no delta offer. Cancellation and freshness fences remain after
asynchronous digest work. Server-generated patches are prohibited: reuse the
student's validated patch to keep server CPU bounded.

The cache still writes the reconstructed full image. Do not claim binary/cache
storage savings from this design. Model exact references, profitable changed-image
patches, full fallback and viewer gzip separately. Moving video/noise remains a
full-image workload. Governed delta pilot/global/off modes must preserve parent
scopes and block turning references off while deltas remain active.
