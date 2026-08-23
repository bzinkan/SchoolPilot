import { useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { goPilotMembershipRoles, primaryGoPilotRole } from '../shared/utils/schoolRoles';

/**
 * Adapter hook that maps the unified AuthContext to the shape
 * expected by GoPilot pages (matching GoPilot's original useAuth + useSchool).
 */
export function useGoPilotAuth() {
  const { user, token, memberships, loading, logout, switchSchool, activeMembership, refetchUser } = useAuth();

  // Map to GoPilot's expected school shape (memoized to prevent infinite re-renders)
  const currentSchool = useMemo(() => activeMembership
    ? {
        id: activeMembership.schoolId,
        name: activeMembership.schoolName || '',
        slug: activeMembership.schoolSlug || '',
        carNumber: activeMembership.carNumber || '',
        timezone: activeMembership.schoolTimezone || 'America/New_York',
        dismissalTime: activeMembership.dismissalTime || '15:00',
      }
    : null, [activeMembership]);

  const currentRole = primaryGoPilotRole(activeMembership);
  const currentRoles = goPilotMembershipRoles(activeMembership);

  const mappedMemberships = useMemo(() => memberships.map((m) => ({
    school_id: m.schoolId,
    school_name: m.schoolName || '',
    school_slug: m.schoolSlug || '',
    role: m.role,
    roles: m.roles || [m.role],
    gopilot_roles: m.gopilotRoles || [m.gopilotRole || m.role],
    car_number: m.carNumber || '',
    school_timezone: m.schoolTimezone || 'America/New_York',
  })), [memberships]);

  return {
    // Auth fields
    user,
    token,
    loading,
    logout,
    refetchUser,
    // School fields (from GoPilot's useSchool)
    currentSchool,
    currentRole,
    currentRoles,
    switchSchool,
    memberships: mappedMemberships,
  };
}
