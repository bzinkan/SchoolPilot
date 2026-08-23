const ROLE_PRIORITY = ['admin', 'school_admin', 'office_staff', 'teacher', 'parent'];
const VALID_ROLES = new Set(ROLE_PRIORITY);

function normalizedRoles(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter((value) => VALID_ROLES.has(value)))]
    .sort((left, right) => ROLE_PRIORITY.indexOf(left) - ROLE_PRIORITY.indexOf(right));
}

export function membershipRoles(membership) {
  const roles = normalizedRoles(membership?.roles);
  if (roles.length > 0) return roles;
  return normalizedRoles([membership?.primaryRole, membership?.role]);
}

export function goPilotMembershipRoles(membership) {
  const productRoles = normalizedRoles(membership?.gopilotRoles);
  if (productRoles.length > 0) return productRoles;
  return normalizedRoles([
    membership?.gopilotRole,
    ...membershipRoles(membership),
  ]);
}

export function hasMembershipRole(membership, ...roles) {
  const active = new Set(membershipRoles(membership));
  return roles.some((role) => active.has(role));
}

export function hasGoPilotRole(membership, ...roles) {
  const active = new Set(goPilotMembershipRoles(membership));
  return roles.some((role) => active.has(role));
}

export function primaryMembershipRole(membership) {
  return membership?.primaryRole || membership?.role || membershipRoles(membership)[0] || null;
}

export function primaryGoPilotRole(membership) {
  return membership?.gopilotRole || goPilotMembershipRoles(membership)[0] || null;
}
