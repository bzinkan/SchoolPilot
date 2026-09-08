export async function refreshSupervisionSetup(client, schoolId) {
  const results = await Promise.allSettled(
    [
      "/api/coverage/supervision-groups",
      "/api/coverage/supervision-groups/browse",
      "/api/coverage/supervision-groups/detail",
      "/api/coverage/supervision-group-categories",
      "/api/coverage/assignments",
      "/api/coverage/capabilities",
      "classpilot-schedule-profiles",
    ].map((key) =>
      client.invalidateQueries(
        { queryKey: [key, schoolId] },
        { throwOnError: true },
      ),
    ),
  );
  return results.some((result) => result.status === "rejected");
}
