import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { apiRequest } from '../../../lib/queryClient';
import { activityRequestHeaders } from '../lib/dashboardActivity';
import { classroomFocusReviewValid } from '../lib/classroomFocus';

// Reviews are uncached capabilities for one exact actor, authority and recipient
// list. Edits retire the native request before any late completion can repaint.
export function useClassroomFocusPreview({ schoolId, viewerId, authority, contextAuthorityRevision,
  targetStudentIds, url, scopeKey, enabled = false }) {
  const binding = JSON.stringify({ schoolId, viewerId, authority, contextAuthorityRevision,
    targetStudentIds, url, scopeKey, enabled });
  const [selection, setSelection] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState(null);
  const [courseResult, setCourseResult] = useState(null);
  const [picker, setPicker] = useState(null);
  const [courseAttempt, setCourseAttempt] = useState(0);
  const request = useRef(null);
  const connectionRequest = useRef(null);
  const courseId = selection?.binding === binding ? selection.courseId : '';
  const key = JSON.stringify({ binding, courseId, attempt });
  const visible = enabled && result?.key === key ? result : null;
  const needsCourse = visible?.failure?.response?.data?.code === 'CLASSROOM_FOCUS_COURSE_REQUIRED';
  const showCourses = enabled && (needsCourse || picker === binding || Boolean(courseId));
  const courseKey = showCourses ? JSON.stringify([binding, courseAttempt]) : null;
  const courses = courseKey && courseResult?.key === courseKey ? courseResult : null;
  // Retire the stored proof as well as hiding it. Returning to an earlier URL,
  // course or actor must wait for a new review rather than revive its old key.
  if (result && result.key !== key) setResult(null);
  if (selection && selection.binding !== binding) setSelection(null);
  if (picker && picker !== binding) setPicker(null);
  if (courseResult && courseResult.key !== courseKey) setCourseResult(null);

  useLayoutEffect(() => () => { request.current?.abort(); connectionRequest.current?.abort(); }, [key]);
  useEffect(() => {
    const { binding: serialized, courseId } = JSON.parse(key);
    const input = JSON.parse(serialized);
    if (!input.enabled || !input.schoolId || !input.viewerId || !input.authority || !input.targetStudentIds?.length) return;
    const controller = new AbortController();
    request.current = controller;
    let expiryTimer;
    apiRequest('POST', '/classpilot/commands/classroom-focus/preview', {
      ...input.authority, targetScope: 'students', targetStudentIds: input.targetStudentIds,
      ...(courseId ? { courseId } : {}),
    }, { signal: controller.signal, headers: activityRequestHeaders(input.schoolId, input.contextAuthorityRevision) })
      .then(data => {
        if (controller.signal.aborted) return;
        if (!classroomFocusReviewValid(data)) throw new Error('The Classroom scope review was incomplete. Review again before setting Focus.');
        setResult({ key, data });
        expiryTimer = setTimeout(() => {
          setResult(current => current?.key === key ? { ...current, expired: true } : current);
        }, data.expiresAt - Date.now());
      }).catch(failure => {
        if (!controller.signal.aborted) setResult({ key, failure });
      });
    return () => { controller.abort(); clearTimeout(expiryTimer); };
  }, [key]);

  useEffect(() => {
    if (!courseKey) return;
    const [serialized] = JSON.parse(courseKey);
    const input = JSON.parse(serialized);
    const controller = new AbortController();
    apiRequest('GET', '/classroom/courses?purpose=classroom_resources', undefined,
      { signal: controller.signal, headers: { 'X-School-Id': input.schoolId } })
      .then(data => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(data?.courses)) throw new Error('The Classroom course list was incomplete.');
        setCourseResult({ key: courseKey, data: data.courses });
      }).catch(failure => { if (!controller.signal.aborted) setCourseResult({ key: courseKey, failure }); });
    return () => controller.abort();
  }, [courseKey]);

  const preview = visible?.data && !visible.expired ? visible.data : null;
  const review = () => { setAttempt(value => value + 1); };
  const connect = async () => {
    connectionRequest.current?.abort();
    const controller = new AbortController();
    connectionRequest.current = controller;
    try {
      const data = await apiRequest('GET', `/google/auth-url?purpose=classroom_resources&returnTo=${encodeURIComponent(`${location.origin}/classpilot`)}`,
        undefined, { signal: controller.signal, headers: { 'X-School-Id': schoolId } });
      if (!controller.signal.aborted && data?.url) location.assign(data.url);
    } catch (failure) { if (!controller.signal.aborted) setResult({ key, failure }); }
  };
  return { preview, pending: enabled && (!visible || visible.pending === true),
    failure: needsCourse ? null : visible?.failure || null,
    error: visible?.expired ? 'This Classroom scope review expired. Review again before setting Focus.' : null,
    review, connect, invalidate: () => setResult(current => current?.key === key ? { ...current, expired: true } : current),
    needsCourse, showCourses, courses: courses?.data || [],
    coursesPending: showCourses && (!courses || courses.pending === true), coursesFailure: courses?.failure,
    courseId, chooseCourse: value => setSelection({ binding, courseId: value }),
    showCoursePicker: () => setPicker(binding), retryCourses: () => setCourseAttempt(value => value + 1),
  };
}
