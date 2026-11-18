# Classroom website Focus Google work access

The owner clarified that Focus on `classroom.google.com` should behave like an
ordinary Classroom Flight Path: Classroom plus Docs, Drive, Sheets, Slides,
Forms and `forms.gle`, with Google Search and unrelated sites blocked. This
replaces the pending all-school assignment-access activation work. No Google
Classroom API connector or runtime capability promotion is needed for this scope.

Use the existing website restriction and a fixed Google work host projection in
the extension's shared matcher and DNR builder. Keep canonical persisted state,
precise resource/section boundaries, control authority, block precedence and
Stop Focus behavior. Update the server preview and teacher explanation to match.
Reusing the reviewed assignment-access envelope would incorrectly couple these
ordinary websites to a separate permission and rollout; changing the preview
alone would leave installed enforcement unchanged.

The extension successor is 3.0.9 because 3.0.7/3.0.8 are already prepared and
reported installed. Preserve their archives. The new package goes in the primary
ClassPilot `dist`; Store publication remains a separate action.

- [ ] Reproduce ordinary Classroom Focus blocking Google work; verify ordinary Flight Path reference behavior.
- [ ] Add RED matcher/native enforcement and server preview tests, then implement the fixed host projection.
- [ ] Verify Search, lookalike hosts, unrelated sites, resource/section Focus, restore, navigation, block precedence and Stop Focus.
- [ ] Update teacher preview/help and extension version guards/candidate record.
- [ ] Independent review, required checks and source CI in both repositories.
- [ ] Merge main, deploy API/web preview changes and verify health/source.
- [ ] Package final reviewed/tagged extension source, run exact-package acceptance, retain hashes under `dist`, clean only task branches/worktrees.
