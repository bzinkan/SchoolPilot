# Restriction scope previews

`POST /api/classpilot/flight-paths/preview-resources` is a read-only authoring
endpoint for authenticated ClassPilot staff in the verified school context.
It uses the same entitlement, role checks, normalizers and bounded Forms
short-link resolver as saving a Flight Path or validating a Waypoint. The body
cannot select a tenant. Responses use `Cache-Control: no-store`.

Request purposes:

| Purpose | Inputs | Reviewed authoring inputs |
| --- | --- | --- |
| `flight_path` | `allowedDomains`, `resources` as save-time `{url}` entries | Canonical `allowedDomains`, `resources` |
| `waypoint` | `url`, `boundary: website/resource` | Canonical `url`; selected boundary is retained |
| `classroom` | Selected items containing `id` and `links: [{url}]`, optional `selectedResourceIds` and `resourceLinks`, explicit boundary | Canonical `resourceLinks`; selected boundary is retained |

Response schema version 1 includes `scopes`, `warnings`, `skipped` and
`authoring`. A scope is an entire website, an exact-host section plus paths
below it, or a provider resource. Website entries explicitly warn about
broader access, including an overlapping precise entry on the same host or
YouTube host family. Invalid precise Classroom links are reported as skipped;
they never become website permissions.

Precise inputs require the school's existing
`preciseRestrictionResourcesV1` authoring gate. Website previews remain
available with that gate off. `CURRENT_URL` needs a per-student browser
observation and cannot be normalized into one shared preview.

The interface must discard an old preview after an input, boundary, selection
or school change. Saving and issuing commands still revalidate every input.
For Classroom creation, submit the reviewed canonical
`authoring.resourceLinks` without resending original selected links: the
creation endpoint combines those two input sources, and unresolved originals
would otherwise be resolved again. Keep selected Classroom IDs as provenance,
with their original `links` omitted from creation inputs.

This endpoint writes no Flight Path, restriction, command, audit event or
runtime setting. Short-link resolution shares the existing resolution limiter
and outbound-host/redirect budgets. Schema, RLS, protocol, deployment and
extension capability declarations are unchanged in this slice.

Local acceptance on September 30, 2026: backend check/build, test type/cast
ratchets, 18 pure preview/resolver cases and 12 existing/new precise Flight
Path HTTP cases passed. HTTP tests used an isolated synthetic local database,
with actual authentication and verified school headers. They cover denied
anonymous access, forged body tenancy, capability-off authoring, no preview
mutation, reviewed scope/save equivalence and selected Classroom boundaries.
Required CI and interface/device acceptance remain separate evidence.
