/**
 * Pure Google Classroom course-listing helpers.
 *
 * No database or connector imports live here so the paging and staff-matching
 * rules can be unit-tested against a fake Classroom client. Callers obtain a
 * client from googleRosterConnector (domain-wide delegation as the school's
 * delegated admin) or from a staff member's own OAuth grant.
 *
 * Listing rule: the delegated-admin client must list WITHOUT `teacherId` so it
 * sees every course in the domain. `teacherId: "me"` is only meaningful on a
 * caller's own OAuth client (it filters to the courses that account teaches);
 * on the delegated-admin client it silently returns only the admin's courses.
 */

/** Cap on courses fetched for the admin import preview (page size is 100). */
export const CLASSROOM_COURSE_PREVIEW_LIMIT = 300;
/** Concurrent per-course roster/staff fan-out against the Classroom API. */
export const CLASSROOM_FANOUT_CONCURRENCY = 6;

const CLASSROOM_PAGE_SIZE = 100;

export type ClassroomCourse = {
  id?: string | null;
  name?: string | null;
  section?: string | null;
  room?: string | null;
  descriptionHeading?: string | null;
  ownerId?: string | null;
  courseState?: string | null;
};

export type ClassroomTeacher = {
  courseId?: string | null;
  userId?: string | null;
  profile?: {
    id?: string | null;
    emailAddress?: string | null;
    name?: {
      givenName?: string | null;
      familyName?: string | null;
      fullName?: string | null;
    } | null;
  } | null;
};

export type ClassroomCoursesListParams = {
  teacherId?: string;
  courseStates?: string[];
  pageSize?: number;
  pageToken?: string;
};

export type ClassroomTeachersListParams = {
  courseId: string;
  pageSize?: number;
  pageToken?: string;
};

type ClassroomPage<T> = Promise<{ data?: (T & { nextPageToken?: string | null }) | null }>;

/** Structural subset of `classroom_v1.Classroom` used by these helpers. */
export type ClassroomCourseListClient = {
  courses: {
    list(params: ClassroomCoursesListParams): ClassroomPage<{ courses?: ClassroomCourse[] | null }>;
    teachers: {
      list(params: ClassroomTeachersListParams): ClassroomPage<{ teachers?: ClassroomTeacher[] | null }>;
    };
  };
};

export type ListClassroomCoursesOptions = {
  /**
   * Restrict to courses taught by this Google user. Pass `"me"` only on a
   * client authorized by the caller's own OAuth grant. Omit for the
   * delegated-admin connector so the listing covers the whole domain.
   */
  teacherId?: string;
  /** Defaults to `["ACTIVE"]`. */
  courseStates?: string[];
  /** Stop paging once this many courses are collected; unlimited when omitted. */
  maxCourses?: number;
};

export type ListClassroomCoursesResult = {
  courses: ClassroomCourse[];
  /** True when `maxCourses` cut the listing short. */
  truncated: boolean;
};

function normalizeMaxCourses(value: number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

export async function listClassroomCourses(
  classroom: ClassroomCourseListClient,
  options: ListClassroomCoursesOptions = {}
): Promise<ListClassroomCoursesResult> {
  const courseStates = options.courseStates ?? ["ACTIVE"];
  const maxCourses = normalizeMaxCourses(options.maxCourses);
  const courses: ClassroomCourse[] = [];
  let pageToken: string | undefined;
  let truncated = false;

  do {
    const params: ClassroomCoursesListParams = { courseStates, pageSize: CLASSROOM_PAGE_SIZE };
    if (options.teacherId) params.teacherId = options.teacherId;
    if (pageToken) params.pageToken = pageToken;
    const response = await classroom.courses.list(params);
    courses.push(...(response?.data?.courses || []));
    pageToken = response?.data?.nextPageToken || undefined;
    if (maxCourses !== undefined && courses.length >= maxCourses) {
      truncated = courses.length > maxCourses || Boolean(pageToken);
      break;
    }
  } while (pageToken);

  return {
    courses: maxCourses !== undefined ? courses.slice(0, maxCourses) : courses,
    truncated,
  };
}

export async function listClassroomCourseTeachers(
  classroom: ClassroomCourseListClient,
  courseId: string
): Promise<ClassroomTeacher[]> {
  const teachers: ClassroomTeacher[] = [];
  let pageToken: string | undefined;
  do {
    const params: ClassroomTeachersListParams = { courseId, pageSize: CLASSROOM_PAGE_SIZE };
    if (pageToken) params.pageToken = pageToken;
    const response = await classroom.courses.teachers.list(params);
    teachers.push(...(response?.data?.teachers || []));
    pageToken = response?.data?.nextPageToken || undefined;
  } while (pageToken);
  return teachers;
}

export type ClassroomCourseStaff = {
  /** Lowercased email of the course owner, when the owner appears in the teacher list. */
  ownerEmail: string | null;
  /** Google user id recorded as `course.ownerId`. */
  ownerGoogleId: string | null;
  /** Lowercased, de-duplicated emails of every other teacher on the course. */
  coTeacherEmails: string[];
};

function normalizeEmail(value: unknown): string | null {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return email ? email : null;
}

function normalizeId(value: unknown): string | null {
  const id = value === undefined || value === null ? "" : String(value).trim();
  return id ? id : null;
}

/**
 * Splits a course's teacher roster into the Classroom owner and co-teachers.
 * The owner is the teacher whose `userId` equals `course.ownerId`; every other
 * teacher with an email is a co-teacher. Ownership is by Google id, so an
 * admin-owned course resolves its owner exactly like a teacher-owned one.
 */
export function classroomCourseStaffFromTeachers(
  course: Pick<ClassroomCourse, "ownerId"> | null | undefined,
  teachers: ClassroomTeacher[] | null | undefined
): ClassroomCourseStaff {
  const ownerGoogleId = normalizeId(course?.ownerId);
  let ownerEmail: string | null = null;
  const coTeacherEmails: string[] = [];
  const seen = new Set<string>();

  for (const teacher of teachers || []) {
    const email = normalizeEmail(teacher?.profile?.emailAddress);
    const teacherGoogleId = normalizeId(teacher?.userId ?? teacher?.profile?.id);
    if (ownerGoogleId !== null && teacherGoogleId === ownerGoogleId) {
      if (!ownerEmail && email) ownerEmail = email;
      continue;
    }
    if (!email || seen.has(email)) continue;
    seen.add(email);
    coTeacherEmails.push(email);
  }

  return {
    ownerEmail,
    ownerGoogleId,
    coTeacherEmails: ownerEmail ? coTeacherEmails.filter((email) => email !== ownerEmail) : coTeacherEmails,
  };
}
