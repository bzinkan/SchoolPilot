const commandStatusRank = new Map([
  ["requested", 0],
  ["sent", 1],
  ["received", 2],
  ["completed", 3],
  ["failed", 3],
  ["unavailable", 3],
  ["expired", 3],
]);

export function teacherSessionOwnerKey(teacherId, teachingSessionId) {
  const normalizedTeacherId = String(teacherId || "").trim();
  const normalizedSessionId = String(teachingSessionId || "").trim();
  return normalizedTeacherId && normalizedSessionId
    ? JSON.stringify([normalizedTeacherId, normalizedSessionId])
    : "";
}

export function classifyCommandSnapshotOwnership(command, observer, knownOwnerKeys) {
  const teacherId = String(command?.teacherId || "").trim();
  const teachingSessionId = String(command?.teachingSessionId || "").trim();
  const actorId = String(observer?.actorId || "").trim();
  const observerSessionId = String(observer?.teachingSessionId || "").trim();
  const commandOwnerKey = teacherSessionOwnerKey(teacherId, teachingSessionId);
  const observerOwnerKey = teacherSessionOwnerKey(actorId, observerSessionId);

  if (
    !commandOwnerKey ||
    !(knownOwnerKeys instanceof Set) ||
    !knownOwnerKeys.has(commandOwnerKey)
  ) return "invalid";
  return observerOwnerKey && commandOwnerKey === observerOwnerKey ? "owned" : "other";
}

export function observeCommandTargetStatuses(entry, targets, observedAt = Date.now()) {
  let regressions = 0;

  for (const target of targets) {
    const targetId = String(target?.id || "").trim();
    const status = String(target?.status || "").trim();
    const rank = commandStatusRank.get(status);
    if (!targetId || rank === undefined) continue;

    const previousStatus = entry.serverTargetStatuses.get(targetId);
    const previousRank = previousStatus === undefined ? -1 : commandStatusRank.get(previousStatus) ?? -1;
    const terminalConflict = previousRank === 3 && previousStatus !== status;
    if ((rank < previousRank || terminalConflict) && !entry.serverRegressedTargetIds.has(targetId)) {
      entry.serverRegressedTargetIds.add(targetId);
      regressions += 1;
    }
    if (rank >= previousRank && !terminalConflict) entry.serverTargetStatuses.set(targetId, status);

    const elapsed = entry.requestStartedAt ? observedAt - entry.requestStartedAt : Infinity;
    if (["received", "completed"].includes(status) && !entry.serverReceivedAtByTarget.has(targetId)) {
      entry.serverReceivedAtByTarget.set(targetId, elapsed);
    }
    if (status === "completed" && !entry.serverCompletedAtByTarget.has(targetId)) {
      entry.serverCompletedAtByTarget.set(targetId, elapsed);
    }
  }

  entry.serverReceived = entry.serverReceivedAtByTarget.size;
  entry.serverCompleted = entry.serverCompletedAtByTarget.size;
  entry.serverReceivedWithin2s = [...entry.serverReceivedAtByTarget.values()].filter((elapsed) => elapsed <= 2_000).length;
  entry.serverCompletedWithin5s = [...entry.serverCompletedAtByTarget.values()].filter((elapsed) => elapsed <= 5_000).length;

  return regressions;
}
