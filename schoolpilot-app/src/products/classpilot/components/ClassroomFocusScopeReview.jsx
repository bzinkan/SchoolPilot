import { Button } from '../../../components/ui/button';
import { Label } from '../../../components/ui/label';
import ClassroomLoadError from './ClassroomLoadError';
import RestrictionScopeReview from './RestrictionScopeReview';

export default function ClassroomFocusScopeReview({ review, disabled = false }) {
  return <div className="space-y-3" data-testid="classroom-focus-review">
    <p className="text-sm">Classroom Focus includes the course's published assignments, materials and assigned outside websites. Review the allowed scope before applying.</p>
    {review.preview && <div className="rounded border p-3 text-sm" data-testid="classroom-focus-course-summary">
      <p className="font-medium">{review.preview.course.name}</p>
      <p>All published assignments and materials in this course</p>
      <p className="text-xs text-muted-foreground">{review.preview.itemCount} published items · {review.preview.linkCount} assigned links</p>
    </div>}
    {!review.showCourses && <Button type="button" variant="ghost" disabled={disabled || review.pending} onClick={review.showCoursePicker}>Choose a different Classroom course</Button>}
    {review.showCourses && <div className="space-y-2">
      <Label htmlFor="classroom-focus-course">Google Classroom course</Label>
      {review.needsCourse && <p className="text-xs text-muted-foreground">This class has no mapped Classroom course. Choose a course from your connected Google account.</p>}
      <select id="classroom-focus-course" className="w-full rounded border bg-background p-2" value={review.courseId}
        disabled={disabled || review.coursesPending || review.pending} onChange={event => review.chooseCourse(event.target.value)}>
        <option value="">Choose a Classroom course</option>
        {review.courses.map(course => <option key={course.id} value={course.id}>{course.name || course.courseName || course.id}</option>)}
      </select>
      {review.coursesPending && <p role="status" className="text-sm">Loading your Classroom courses…</p>}
      {review.coursesFailure && <ClassroomLoadError error={review.coursesFailure} subject="Courses" onConnect={() => void review.connect()} onRetry={review.retryCourses} retrying={review.coursesPending} />}
    </div>}
    {review.failure && <ClassroomLoadError error={review.failure} subject="Classroom scope" onConnect={() => void review.connect()} onRetry={review.review} retrying={review.pending} />}
    <RestrictionScopeReview review={review} disabled={disabled || (review.needsCourse && !review.courseId)} />
  </div>;
}
