/** Pure, bounded schedule analysis. Student identifiers never leave this module's result. */
export type StudentAnalysisInterval = { start: number; end: number };
export type StudentAnalysisStaff = { id: string; name: string };
export type StudentAnalysisClass = {
  classId: string; name: string; staff: readonly StudentAnalysisStaff[];
  studentIds: readonly string[] | null; window: StudentAnalysisInterval | null;
  /** Unknown schedule/roster/assignment facts, distinct from a known nonmeeting class. */
  unavailable?: boolean;
};
export type StudentAnalysisTesting = {
  blockId: string; name: string; staff: readonly StudentAnalysisStaff[];
  studentIds: readonly string[] | null; window: StudentAnalysisInterval | null;
  /** Caller has checked eligibility, monitoring, group/staff and teaching obligations. */
  validForPrecedence: boolean;
};
export type StudentAnalysisOverlap = {
  classIds: string[]; staffIds: string[]; window: StudentAnalysisInterval;
  studentCount: number; newStudentCount: number; change: "new" | "worsened" | "existing" | "reduced";
};
export type AfterTestingAllocation = {
  kind: "class" | "gap" | "none" | "multiple" | "continuing_testing" | "unavailable";
  studentCount: number; classIds: string[]; blockIds: string[]; staff: StudentAnalysisStaff[]; at: number | null;
};
export type AfterTestingAnalysis = {
  blockId: string; status: "ready" | "unavailable"; studentCount: number | null; allocations: AfterTestingAllocation[];
};
export type StudentAnalysisResult = {
  complete: boolean; limitReached: boolean; unavailableClassIds: string[];
  overlaps: StudentAnalysisOverlap[]; afterTesting: AfterTestingAnalysis[];
};
const DEFAULT_LIMITS = { classes: 5000, testing: 2000, relationships: 250000, operations: 1000000, overlaps: 2000 };
export const validStudentAnalysisInterval = (value: StudentAnalysisInterval | null): value is StudentAnalysisInterval =>
  !!value && Number.isFinite(value.start) && Number.isFinite(value.end) && value.start < value.end;
const intersects = (a: StudentAnalysisInterval, b: StudentAnalysisInterval) => a.start < b.end && b.start < a.end;
const unique = (values: readonly string[]) => [...new Set(values)].sort();
const staffUnion = (rows: readonly { staff: readonly StudentAnalysisStaff[] }[]) =>
  [...new Map(rows.flatMap((row) => row.staff.map((staff) => [staff.id, staff] as const))).values()].sort((a, b) => a.id.localeCompare(b.id));
function union(windows: StudentAnalysisInterval[]) {
  const result: StudentAnalysisInterval[] = [];
  for (const window of [...windows].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = result.at(-1);
    if (last && window.start <= last.end) last.end = Math.max(last.end, window.end);
    else result.push({ ...window });
  }
  return result;
}
function subtract(windows: StudentAnalysisInterval[], masks: StudentAnalysisInterval[]) {
  let result = windows;
  for (const mask of masks) result = result.flatMap((window) => !intersects(window, mask) ? [window] : [
    ...(window.start < mask.start ? [{ start: window.start, end: mask.start }] : []),
    ...(mask.end < window.end ? [{ start: mask.end, end: window.end }] : []),
  ]);
  return result;
}
function unavailableReturn(block: StudentAnalysisTesting): AfterTestingAnalysis {
  const studentCount = block.studentIds === null ? null : new Set(block.studentIds).size;
  return { blockId: block.blockId, status: "unavailable", studentCount, allocations: studentCount === null ? [] : [
    { kind: "unavailable", studentCount, classIds: [], blockIds: [], staff: [], at: null },
  ] };
}

/** Baseline and proposal must describe the same actual date and authoritative roster facts. */
export function analyzeScheduleStudents(options: {
  baselineClasses: readonly StudentAnalysisClass[]; classes: readonly StudentAnalysisClass[];
  baselineTesting?: readonly StudentAnalysisTesting[]; testing: readonly StudentAnalysisTesting[];
  limits?: Partial<typeof DEFAULT_LIMITS>;
}): StudentAnalysisResult {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  let operations = 0;
  const exhausted = Symbol("analysis limit");
  const work = (amount = 1) => { operations += amount; if (operations > limits.operations) throw exhausted; };
  const unavailableClassIds = unique([...options.baselineClasses, ...options.classes].filter((row) =>
    row.unavailable || row.studentIds === null || (row.window !== null && !validStudentAnalysisInterval(row.window)))
    .map((row) => row.classId));
  const unavailable = new Set(unavailableClassIds);
  const fallback = (): StudentAnalysisResult => ({ complete: false, limitReached: true, unavailableClassIds, overlaps: [], afterTesting: options.testing.map(unavailableReturn) });
  const allClasses = [...options.baselineClasses, ...options.classes], allTesting = [...(options.baselineTesting ?? []), ...options.testing];
  if (Math.max(options.baselineClasses.length, options.classes.length) > limits.classes
    || Math.max(options.baselineTesting?.length ?? 0, options.testing.length) > limits.testing
    || allClasses.reduce((count, row) => count + (row.studentIds?.length ?? 0), 0)
      + allTesting.reduce((count, row) => count + (row.studentIds?.length ?? 0), 0) > limits.relationships) return fallback();
  try {
    function validTesting(rows: readonly StudentAnalysisTesting[]) {
      const candidates = rows.filter((row) => row.validForPrecedence && validStudentAnalysisInterval(row.window) && !!row.studentIds?.length);
      const rejected = new Set<StudentAnalysisTesting>();
      const targets = new Map(candidates.map((row) => [row, new Set(row.studentIds!)]));
      for (let i = 0; i < candidates.length; i++) for (let j = 0; j < i; j++) {
        work();
        const a = candidates[i]!, b = candidates[j]!;
        if (!intersects(a.window!, b.window!)) continue;
        work(a.studentIds!.length + a.staff.length * b.staff.length);
        if (a.staff.some((staff) => b.staff.some((other) => other.id === staff.id))
          || a.studentIds!.some((id) => targets.get(b)!.has(id))) { rejected.add(a); rejected.add(b); }
      }
      return candidates.filter((row) => !rejected.has(row));
    }
    const baselineTesting = validTesting(options.baselineTesting ?? []), testing = validTesting(options.testing);
    type Pair = { classIds: string[]; staffIds: Set<string>; students: Map<string, StudentAnalysisInterval[]> };
    function pairs(classes: readonly StudentAnalysisClass[], blocks: StudentAnalysisTesting[]) {
      const byStudent = new Map<string, StudentAnalysisClass[]>(), masks = new Map<string, StudentAnalysisInterval[]>();
      for (const block of blocks) for (const id of unique(block.studentIds!)) {
        work(); const values = masks.get(id) ?? []; values.push(block.window!); masks.set(id, values);
      }
      for (const row of classes) {
        if (unavailable.has(row.classId) || !validStudentAnalysisInterval(row.window) || row.studentIds === null) continue;
        for (const id of unique(row.studentIds)) { work(); const values = byStudent.get(id) ?? []; values.push(row); byStudent.set(id, values); }
      }
      const result = new Map<string, Pair>();
      for (const [studentId, rows] of byStudent) {
        rows.sort((a, b) => a.window!.start - b.window!.start);
        for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length && rows[j]!.window!.start < rows[i]!.window!.end; j++) {
          work(); const a = rows[i]!, b = rows[j]!;
          if (a.classId === b.classId) continue;
          const classIds = [a.classId, b.classId].sort(), key = JSON.stringify(classIds);
          const raw = [{ start: Math.max(a.window!.start, b.window!.start), end: Math.min(a.window!.end, b.window!.end) }];
          work(masks.get(studentId)?.length ?? 0);
          const residual = subtract(raw, masks.get(studentId) ?? []);
          if (!residual.length) continue;
          const pair = result.get(key) ?? { classIds, staffIds: new Set<string>(), students: new Map<string, StudentAnalysisInterval[]>() };
          for (const staff of [...a.staff, ...b.staff]) pair.staffIds.add(staff.id);
          pair.students.set(studentId, [...(pair.students.get(studentId) ?? []), ...residual]); result.set(key, pair);
        }
      }
      for (const pair of result.values()) for (const [id, windows] of pair.students) pair.students.set(id, union(windows));
      return result;
    }
    const before = pairs(options.baselineClasses, baselineTesting), after = pairs(options.classes, testing);
    const overlaps: StudentAnalysisOverlap[] = [];
    for (const [key, pair] of after) {
      const baseline = before.get(key), events = new Map<number, { count: number; added: number }>();
      const event = (at: number, count: number, added: number) => {
        const value = events.get(at) ?? { count: 0, added: 0 }; value.count += count; value.added += added; events.set(at, value);
      };
      let reduced = false;
      for (const [id, windows] of baseline?.students ?? []) {
        work(windows.length * Math.max(1, pair.students.get(id)?.length ?? 0));
        if (subtract(windows, pair.students.get(id) ?? []).length) reduced = true;
      }
      for (const [id, windows] of pair.students) {
        const baselineWindows = baseline?.students.get(id) ?? [];
        work(windows.length * Math.max(1, baselineWindows.length));
        const added = subtract(windows, baselineWindows);
        for (const window of windows) { event(window.start, 1, 0); event(window.end, -1, 0); }
        for (const window of added) { event(window.start, 0, 1); event(window.end, 0, -1); }
      }
      const times = [...events.keys()].sort((a, b) => a - b);
      let count = 0, added = 0;
      for (let i = 0; i < times.length - 1; i++) {
        work(); const start = times[i]!, end = times[i + 1]!, change = events.get(start)!; count += change.count; added += change.added;
        if (!count) continue;
        const classification = added ? (baseline ? "worsened" : "new") : reduced ? "reduced" : "existing";
        // Equal counts at adjacent spans can represent different pupils. Preserve
        // membership transition boundaries rather than imply one cohort throughout.
        overlaps.push({ classIds: pair.classIds, staffIds: [...pair.staffIds].sort(), window: { start, end }, studentCount: count, newStudentCount: added, change: classification });
        if (overlaps.length > limits.overlaps) throw exhausted;
      }
    }
    const testingSet = new Set(testing);
    const classRosters = new Map(options.classes.map((row) => [row, new Set(row.studentIds ?? [])]));
    const testingRosters = new Map(options.testing.map((row) => [row, new Set(row.studentIds ?? [])]));
    const afterTesting = options.testing.map((block): AfterTestingAnalysis => {
      if (!testingSet.has(block)) return unavailableReturn(block);
      const at = block.window!.end, allocations = new Map<string, AfterTestingAllocation>();
      for (const id of unique(block.studentIds!)) {
        let allocation: Omit<AfterTestingAllocation, "studentCount">;
        work(options.classes.length + options.testing.length);
        const uncertainClass = options.classes.some((row) => (row.studentIds === null || unavailable.has(row.classId) || (row.window !== null && !validStudentAnalysisInterval(row.window)))
          && (row.studentIds === null || classRosters.get(row)!.has(id))
          && (unavailable.has(row.classId) || row.window === null || !validStudentAnalysisInterval(row.window) || row.window.end > at));
        const uncertainTesting = options.testing.some((other) => other !== block && !testingSet.has(other)
          && (other.studentIds === null || testingRosters.get(other)!.has(id))
          && (!validStudentAnalysisInterval(other.window) || (other.window.start <= at && at < other.window.end)));
        const continuing = testing.filter((other) => other !== block && testingRosters.get(other)!.has(id) && other.window!.start <= at && at < other.window!.end);
        if (uncertainTesting || uncertainClass) allocation = { kind: "unavailable", classIds: [], blockIds: [], staff: [], at: null };
        else if (continuing.length) allocation = { kind: "continuing_testing", classIds: [], blockIds: unique(continuing.map((row) => row.blockId)), staff: staffUnion(continuing), at };
        else {
          const future = options.classes.filter((row) => classRosters.get(row)!.has(id) && validStudentAnalysisInterval(row.window) && row.window.end > at);
          const current = future.filter((row) => row.window!.start <= at);
          const nextAt = current.length ? at : Math.min(...future.map((row) => row.window!.start));
          const destinations = current.length ? current : future.filter((row) => row.window!.start === nextAt);
          const classIds = unique(destinations.map((row) => row.classId));
          allocation = { kind: classIds.length > 1 ? "multiple" : current.length ? "class" : destinations.length ? "gap" : "none",
            classIds, blockIds: [], staff: staffUnion(destinations), at: destinations.length ? nextAt : null };
        }
        const key = JSON.stringify(allocation), previous = allocations.get(key);
        if (previous) previous.studentCount++; else allocations.set(key, { ...allocation, studentCount: 1 });
      }
      const values = [...allocations.values()];
      return { blockId: block.blockId, status: values.some((row) => row.kind === "unavailable") ? "unavailable" : "ready", studentCount: unique(block.studentIds!).length, allocations: values };
    });
    return { complete: unavailableClassIds.length === 0, limitReached: false, unavailableClassIds, overlaps, afterTesting };
  } catch (error) { if (error === exhausted) return fallback(); throw error; }
}
