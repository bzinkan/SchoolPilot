# ClassPilot app buttons

Teachers can choose reusable learning-tool buttons instead of typing website addresses in Open URL, website/resource Focus, and Flight Path authoring. App buttons use the current SchoolPilot website/resource command flow; no browser extension protocol or Chrome Web Store release changes.

## Catalog and privacy

Common apps include Google Classroom, its Google work bundle, Docs, Slides, Sheets, Forms, Drive, IXL and Quill. Individual Google tools open their product home pages. Website restrictions remain hostname-based: the Google Docs website includes Docs, Slides, Sheets and Forms. Classroom access retains the existing fixed Google work expansion and the current Classroom student-access preview. Individual Classroom buttons save only the Classroom hostname while displaying its effective access; removing Classroom also removes that implicit expansion. The explicit bundle saves its advertised sites intentionally. The picker displays the effective website access; it never promises Classroom-only or per-tool isolation or grants all of google.com.

Teachers create private buttons using a name and HTTP(S) address. School administrators maintain shared school buttons. Definitions and each teacher's saved/favorite state are school-scoped and tenant-isolated. Favoriting also saves a button; removing it from My Apps clears its favorite and leaves a personal definition available to manage elsewhere. Saved Flight Paths copy website selections, so later button edits/deletion do not silently change them. Common catalog definitions and other teachers' personal websites cannot be edited by an administrator.

Choosing an app only fills the existing URL or adds websites to a Flight Path draft. Teachers still review recipients, restriction scope and student access, then confirm the existing classroom action. School blocks, sign-in policies, Classroom resource access previews and capability checks remain authoritative. Manual input stays available when the app library cannot load. Built-in icons and custom initials avoid external favicon or website scraping.

Automatic Clever discovery, automatic recent apps, custom bundles and new filtering behavior are deferred.

## API

`/api/classpilot/apps` is authenticated, active-school and ClassPilot entitled, with teacher/admin roles. Support impersonation cannot open this private library, including previously cached entries. Write transactions recheck school entitlement and current staff authority under the lifecycle locks.

- GET `/` returns `{apps, canManageSchoolApps}`. Entries contain key, kind, source, name, launchUrl, allowedDomains, effectiveAllowedDomains, iconKey, saved, favorite, revision and canEdit; bundles also list includedApps.
- POST `/` accepts `{scope: "personal"|"school", name, launchUrl}`. School definitions require administrator authority; personal creation saves to My Apps automatically.
- PATCH `/:key` accepts `{name, launchUrl, expectedRevision}`. DELETE `/:key` accepts `{expectedRevision}`. Stale changes return 409; the client preserves the draft or original confirmation while refreshing saved definitions.
- PUT `/:key/preferences` accepts `{saved, favorite}` for the current viewer; favorites require saved=true.
- Non-delete mutations return `{app}`; DELETE returns 204. URI-encoded keys are `builtin:<slug>` or `saved:<id>`. School and owner identity come from verified context, not request bodies.

School app changes are audited atomically using identifiers without copying saved URLs into audit text.

## Migration and release

`classpilot-apps-20261118` adds `classpilot_app_buttons` and `classpilot_app_button_preferences` with forced tenant RLS. The reviewed `classpilotApps` bundle appends the two tables after the immutable 140-table Today Schedule candidate inventory. The new source/CI target is `classpilotAppsPostExpand` with 142 tables. Source inventory is not production admission; preserve the actual live API/worker table lists and all existing flags, adding only these two app tables.

Follow CLAUDE.md. Deploy backend migrations and their live RLS catalog check before the frontend, using the reviewed one-shot table delta:

```text
--enable-rls-table classpilot_app_buttons,classpilot_app_button_preferences
```

No Terraform apply or extension upload is needed. An additive backend/frontend rollback retains saved app data. Managed-device capability support and live student authorization remain separate from Store publication.

## Validation

App tests cover private ownership, shared permissions, support-mode refusal and cache suppression, tenant isolation, queued authority revocation, revision conflicts, favorites, URL validation, migration idempotence, and non-owner RLS. Browser checks cover selection without sending, controlled URL highlighting, explicit multi-app additions, Google website scopes, manual fallback, and the existing current Focus/Flight Path authoring flows. Generated teacher/admin guides stay aligned with their in-app source.
