import RestrictionScopeReview from './RestrictionScopeReview';

export default function StudentClassroomAccessReview({ review, disabled = false, automatic = false, testId = 'student-classroom-access-review' }) {
  const preview = review.preview;
  const failure = review.failure?.response?.data?.error || review.failure?.message;
  return <div className="space-y-3" data-testid={testId}>
    <p className="text-sm">Students can use all of their own Google Classroom courses, published assignments and materials. Each student receives only their own assigned websites and videos. Google Search and unapproved websites stay blocked.</p>
    <p className="text-xs text-muted-foreground">Google work apps and all files in those apps are included. Outside links allow the whole website and its subdomains. School and teacher block rules still apply.</p>
    {automatic && <p className="rounded border p-3 text-sm">Saving this class preset authorizes current and future published Classroom work from each student's own courses at the start of every class. The current session keeps its existing controls.</p>}
    {preview && <div className="rounded border p-3 text-sm" data-testid="student-classroom-summary">
      <p className="font-medium">All students' own Classroom courses</p>
      <p>{preview.studentCount} student{preview.studentCount === 1 ? '' : 's'} · {preview.courseCount} course enrolments</p>
      <p className="text-xs text-muted-foreground">{preview.itemCount} published items · {preview.linkCount} assigned links</p>
    </div>}
    {failure && <div role="alert" className="space-y-1 text-sm text-destructive">
      <p>{failure}</p><p>School Google Workspace authorization is required for assignment access across students' courses. An administrator can configure this in ClassPilot IT Readiness.</p>
    </div>}
    <RestrictionScopeReview review={{ ...review, preview: preview ? { ...preview, skipped: [] } : null }} disabled={disabled} />
  </div>;
}
