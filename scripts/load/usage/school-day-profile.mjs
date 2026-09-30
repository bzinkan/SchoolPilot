// This separately named school-day workload preserves the immutable extreme
// fixture. The 10-second cadence matches ClassPilot service-worker.js:605.
export const SCHOOL_DAY_PROFILE = Object.freeze({
  name: 'six-lessons-200-domains-1m-unique', students: 500, classes: 100,
  studentsPerClass: 5, periods: 6, lessonMinutes: 50, passingMinutes: 10,
  observationsPerStudent: 2000, cadenceSeconds: 10, domainDwellSeconds: 200,
  domainsPerStudent: 8, domainsSchoolWide: 200, rawPerSchool: 1_000_000,
  sourceCadence: 'ClassPilot/extension/service-worker.js:605 HEARTBEAT_INTERVAL_MS=10000',
});

export function schoolDayStudentIndices(scope) {
  const indices = Array.from({ length: 500 }, (_, index) => index);
  return indices.filter(index => scope === 'school' || (scope === 'grade' ? index % 5 === 0 : scope === 'student' ? index === 0 : true));
}

export function schoolDaySessionRoster(groupIndex, period) {
  const cohort = (groupIndex - period + 100) % 100;
  return Array.from({ length: 5 }, (_, member) => cohort * 5 + member);
}

export function schoolDayObservation(student, sample) {
  const seconds = sample * 10;
  const period = Math.floor(seconds / 3600);
  const lesson = seconds - period * 3600 < 3000;
  const classIndex = lesson ? (Math.floor(student / 5) + period) % 100 : null;
  const domain = `lesson-${student % 25 * 8 + Math.floor(seconds / 200) % 8}.example.test`;
  const classification = sample % 4 === 0 || sample % 4 === 3 ? 'educational' : sample % 4 === 1 ? 'non-educational' : 'unknown';
  return { student, sample, seconds, period: lesson ? period : null, classIndex, domain, classification, attributedSeconds: sample === 1999 ? 15 : 10 };
}

// Independent arithmetic over the declared observations and non-overlapping
// frozen lesson windows; no product SQL or aggregate rows are used.
export function schoolDayOracle(scope) {
  const allowed = new Set(schoolDayStudentIndices(scope));
  const totals = { monitored: 0, instructional: 0, offTask: 0, unknown: 0, heartbeats: 0 };
  const students = new Set(), grains = new Set(), domains = { educational: new Map(), 'non-educational': new Map() };
  for (const student of allowed) for (let sample = 0; sample < 2000; sample++) {
    const observation = schoolDayObservation(student, sample);
    if (scope === 'class' && observation.classIndex !== 0) continue;
    const seconds = observation.attributedSeconds;
    totals.monitored += seconds; totals.heartbeats++;
    totals[observation.classification === 'educational' ? 'instructional' : observation.classification === 'non-educational' ? 'offTask' : 'unknown'] += seconds;
    students.add(student);
    grains.add([student, observation.classIndex, observation.period, observation.domain, observation.classification].join('|'));
    const domainTotals = domains[observation.classification];
    if (domainTotals) domainTotals.set(observation.domain, (domainTotals.get(observation.domain) || 0) + seconds);
  }
  return { ...totals, students: students.size, grains: grains.size, domains };
}

export function schoolDayRangeDomains(scope, historyDays, includeHeavy, oracle = schoolDayOracle(scope)) {
  const heavy = { educational: new Map(includeHeavy ? oracle.domains.educational : []), 'non-educational': new Map(includeHeavy ? oracle.domains['non-educational'] : []) };
  for (const student of schoolDayStudentIndices(scope).filter(index => scope !== 'class' || index < 5)) {
    for (const category of ['educational', 'non-educational']) {
      const domain = `history-${student % 200}.example.test`;
      heavy[category].set(domain, (heavy[category].get(domain) || 0) + historyDays * 30);
    }
  }
  const top = category => [...heavy[category]].map(([domain, seconds]) => ({ domain, seconds }))
    .sort((left, right) => right.seconds - left.seconds || (left.domain < right.domain ? -1 : left.domain > right.domain ? 1 : 0)).slice(0, 10);
  // Domains are ASCII, matching the API's lexical tie order for this fixture.
  return { educational: top('educational'), nonEducational: top('non-educational') };
}
