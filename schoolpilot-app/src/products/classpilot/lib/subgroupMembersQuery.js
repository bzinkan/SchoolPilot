const EMPTY_SUBGROUP_MEMBERS = Object.freeze([]);

export function subgroupMembersQueryKey(groupId, subgroupId) {
  return [
    '/api/subgroups',
    groupId || null,
    subgroupId || null,
    'members',
  ];
}

export function createSubgroupMembersQuery({ groupId, subgroupId, requestApi }) {
  return {
    queryKey: subgroupMembersQueryKey(groupId, subgroupId),
    enabled: Boolean(groupId && subgroupId),
    queryFn: async ({ signal }) => {
      const data = await requestApi(
        'GET',
        `/subgroups/${encodeURIComponent(subgroupId)}/members`,
        undefined,
        { signal },
      );
      return (data?.members || EMPTY_SUBGROUP_MEMBERS)
        .map((member) => member?.studentId || member)
        .filter((studentId) => typeof studentId === 'string' && studentId.length > 0);
    },
  };
}
