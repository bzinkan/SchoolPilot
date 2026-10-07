# Reviewed main-branch protection proposal

Status: **PENDING owner approval and observed enforcement**. The two payloads in
`release-protections/` are proposed settings, not an applied ruleset. No workflow
or GitHub setting is changed by this PR.

The [October 7 read-only observation](release-protections/observation-20261007.json)
records both main branches as unprotected, no returned rulesets, and successful
checks on SchoolPilot `56df7a4f` and ClassPilot `03a9c363`. Refresh that observation
and the exact emitted contexts before application; it does not certify future PRs.

## Proposed configuration

| Repository | Reviewed payload | Required checks |
|---|---|---|
| SchoolPilot | [SchoolPilot ruleset](release-protections/schoolpilot.ruleset.proposed.json) | Backend, cross-tenant, restricted-role RLS, frontend build, four release shards, conditional rollout job, seven governance jobs, CodeQL and secret scan |
| ClassPilot | [ClassPilot ruleset](release-protections/classpilot.ruleset.proposed.json) | `test` and all four emitted Chrome compatibility contexts |

Both payloads require PR changes to `refs/heads/main`, resolved review threads,
up-to-date required checks from GitHub Actions integration 15368, and prevent
deletion and force pushes. The sole named bypass actor is the observed owner
`bzinkan` (public user ID 225512924), restricted to PR bypass. No app, deploy key,
repository role or other administrator receives bypass in this proposal.

Required approving reviews are zero: the single maintainer cannot provide an
independent approval of their own change. Stale approvals are dismissed when
reviewable commits change. Mandatory code-owner and last-pusher-independent review
remain off until another reviewer is available. AI review is additional feedback,
not independent human approval. Existing merge methods are retained.

## Check applicability

| Workflow / emitted context | Main push | PR to main | Proposal treatment |
|---|---|---|---|
| SchoolPilot CI backend, both isolation jobs, frontend, four shards, seven SOC 2 jobs | Runs | Runs | Require each exact context from the payload |
| `AWS rollout safety (PowerShell + Terraform)` | Runs | Runs when rollout inputs change or path detection fails; emits skipped only after successful negative detection | Require context; verify relevant-path PR cannot skip it |
| `Detect changed paths` | Job skipped | Runs | Not universally required; rollout condition fails closed on missing/failed detection |
| `Analyze (javascript-typescript)` | Runs | Runs | Require; the current CodeQL gate blocks error-severity findings; warning findings remain backlog #60 |
| `Scan for secrets` | Runs | Runs | Require |
| `Scan Docker image` | Runs | Entire workflow is path-filtered to Dockerfile/package manifests/scan workflow | Excluded from universal required contexts; report this enforcement gap explicitly |
| Immutable release-image publication | Opt-in after CI | Does not run | Not a merge requirement; retain publication prerequisites separately |
| ClassPilot `test` | Runs | Runs | Require; includes check/test/build, native extension and package validation |
| Four `chrome-compatibility (...)` matrix contexts | Runs | Runs | Require exact emitted contexts, including stable |

Check names were taken from actual check runs, not inferred from job IDs. Workflow
sources are SchoolPilot `.github/workflows/{ci-build,codeql,gitleaks,trivy,release-image}.yml`
and ClassPilot `.github/workflows/ci.yml` at the observed SHAs. A branch protection
does not prove a skipped essential test ran. The rollout exception applies only
to the documented negative path match. Container scanning is not universally
enforced pre-merge by these payloads: a separate small workflow change is needed
before adding its context universally. Neither optional image publication nor
code-scanning upload availability should be substituted for existing checks.

## Operator application and verification

1. Refresh main, rulesets (including inherited rules), branch protections and
   latest PR contexts. Inspect any intervening workflow/matrix changes. Review
   desired payloads and retain their SHA-256, current settings and owner approval.
2. Confirm repository support and write permission. Use the GitHub rules UI or
   `POST /repos/bzinkan/<repository>/rulesets` with the reviewed payload and
   supported API version `2026-03-10`. Do not create duplicates if a matching
   ruleset now exists; review an update instead. The payload requests active
   enforcement, so this step requires separate settings approval.
3. Read back the returned ID and ruleset, then
   `GET /repos/bzinkan/<repository>/rules/branches/main`. Compare every condition,
   bypass actor, rule and required context to the approved payload. Do not infer
   enforcement from a successful POST alone.
4. Verify actual PR behavior without merging or exercising the owner's bypass:
   observe the ordinary blocked state. An ordinary PR must wait for its
   required checks; an unresolved thread blocks it; a failed essential check
   blocks it. Verify both an unrelated-path and rollout-relevant SchoolPilot PR,
   confirming legitimate skip versus actual rollout execution. Verify all five
   ClassPilot contexts on a PR. Retain observations, not synthetic pass claims.
5. Mark enforcement passed only after readback and PR behavior are observed.
   Settings approval, application and validation remain separate states.

Operator commands must use a saved body file (`gh api ... --input <payload>`),
not interpolated JSON. Capture only safe settings metadata in public evidence.
The API shape follows the [official GitHub repository rules API](https://docs.github.com/en/rest/repos/rules).

## Emergency bypass and recovery

The owner may bypass through a PR only for a documented emergency. Record the
incident, exact SHA, skipped/failed checks, rationale, containment, remaining
validation and repair follow-up before merge. Bypass grants no deployment or
activation authority. Run the omitted checks afterward and retain their results.
Do not broaden bypass actors or disable the ruleset for a routine failed check.

If a settings mistake blocks legitimate work, first prepare a reviewed correction
using the captured prior settings. Restore only the affected ruleset with a
separate approved update and verify readback. The current baseline has no ruleset;
disabling/deleting a newly applied one would restore that unprotected baseline,
not prove safety. Never delete unrelated rulesets or use destructive Git commands
as a protection test.
