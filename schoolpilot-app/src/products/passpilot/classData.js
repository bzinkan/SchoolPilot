import { useQuery } from "@tanstack/react-query";

import api from "../../shared/utils/api";

export const PASSPILOT_CLASSES_QUERY_KEY = ["passpilot", "classes"];
export const PASSPILOT_HISTORY_CLASSES_QUERY_KEY = ["passpilot", "classes", "history"];
export const PASSPILOT_CLASS_MODEL_HEADER = {
  "X-PassPilot-Class-Model": "classpilot-groups-v1",
};

export const PASSPILOT_CLASS_SOURCES = {
  LEGACY: "legacy_grades",
  CANONICAL: "classpilot_groups",
};

export function isCanonicalPassPilotSource(source) {
  return source === PASSPILOT_CLASS_SOURCES.CANONICAL;
}

export async function passPilotClassRequest(method, url, data) {
  const response = await api({
    method,
    url,
    data,
    headers: PASSPILOT_CLASS_MODEL_HEADER,
  });
  return response.data;
}

export async function fetchAllPassPilotHistory(url) {
  const [path, rawQuery = ""] = String(url).split("?", 2);
  const baseParams = new URLSearchParams(rawQuery);
  baseParams.set("limit", "500");

  const passes = [];
  const seenCursors = new Set();
  let cursor = null;

  // The guard makes a malformed or unexpectedly cyclic server response fail
  // visibly instead of producing a partial report or an infinite request loop.
  for (let page = 0; page < 200; page += 1) {
    const params = new URLSearchParams(baseParams);
    if (cursor) params.set("cursor", cursor);
    else params.delete("cursor");

    const data = await passPilotClassRequest("GET", `${path}?${params.toString()}`);
    if (Array.isArray(data)) return [...passes, ...data];

    const pagePasses = Array.isArray(data?.passes) ? data.passes : [];
    passes.push(...pagePasses);
    if (!data?.hasMore) return passes;

    const nextCursor = typeof data?.nextCursor === "string" ? data.nextCursor : "";
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error("Pass history pagination did not advance");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new Error("Pass history is too large to load safely in one report");
}

function normalizeTeacher(teacher) {
  if (!teacher) return null;
  return {
    ...teacher,
    id: teacher.id || teacher.userId || teacher.teacherId || "",
    displayName:
      teacher.displayName
      || teacher.name
      || [teacher.firstName, teacher.lastName].filter(Boolean).join(" ")
      || teacher.email
      || "Assigned teacher",
  };
}

export function normalizePassPilotClass(item) {
  const id = item?.id || item?.classId || item?.groupId || item?.gradeId || item?.legacyGradeId || "";
  const classId = item?.classId || item?.groupId || item?.filterKey?.value || id;
  const coTeachers = Array.isArray(item?.coTeachers)
    ? item.coTeachers.map(normalizeTeacher).filter(Boolean)
    : [];

  return {
    ...item,
    id,
    classId,
    name: item?.name || item?.className || "Untitled class",
    description: item?.description || null,
    periodLabel: item?.periodLabel || null,
    gradeLevel: item?.gradeLevel || null,
    status: item?.status || "active",
    studentCount: Number(item?.studentCount ?? item?.rosterCount ?? item?.students?.length ?? 0),
    primaryTeacher: normalizeTeacher(item?.primaryTeacher || item?.teacher),
    coTeachers,
    source: item?.source || null,
  };
}

export function normalizePassPilotClassesResponse(data) {
  const rawClasses = Array.isArray(data) ? data : (data?.classes ?? data?.items ?? []);
  return {
    // The persisted server value is the only class-mode authority. Missing or
    // unknown values deliberately do not opt a school into canonical mode.
    source: data?.source || null,
    classes: rawClasses.map(normalizePassPilotClass).filter((item) => item.id),
    migration: data?.migration || null,
  };
}

export function useCanonicalPassPilotClasses(enabled = true) {
  return useQuery({
    queryKey: PASSPILOT_CLASSES_QUERY_KEY,
    queryFn: () => passPilotClassRequest("GET", "/passpilot/classes"),
    select: normalizePassPilotClassesResponse,
    enabled,
  });
}

export function usePassPilotHistoryClasses(enabled = true) {
  return useQuery({
    queryKey: PASSPILOT_HISTORY_CLASSES_QUERY_KEY,
    queryFn: () => passPilotClassRequest("GET", "/passpilot/classes?scope=history"),
    select: normalizePassPilotClassesResponse,
    enabled,
  });
}

export function teacherLabel(item) {
  const primary = item?.primaryTeacher?.displayName;
  const coTeacherCount = item?.coTeachers?.length || 0;
  if (!primary) return "Teacher not assigned";
  if (coTeacherCount === 0) return primary;
  return `${primary} + ${coTeacherCount} co-${coTeacherCount === 1 ? "teacher" : "teachers"}`;
}
