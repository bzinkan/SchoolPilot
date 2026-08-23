import { useAuth } from '../contexts/AuthContext';
import { queryClient } from '../lib/queryClient';
import { hasMembershipRole, membershipRoles, primaryMembershipRole } from '../shared/utils/schoolRoles';

/**
 * Adapter hook that maps the unified AuthContext to the shape
 * expected by PassPilot pages (matching PassPilot's original useAuth).
 */
export function usePassPilotAuth() {
  const {
    user: unifiedUser,
    loading,
    logout,
    activeSchoolId,
    activeMembership,
    refetchUser,
  } = useAuth();

  // Derive the PassPilot role from the unified membership role
  const membershipRole = primaryMembershipRole(activeMembership);
  const roles = membershipRoles(activeMembership);
  let role = null;
  if (membershipRole === 'admin' || membershipRole === 'school_admin') {
    role = 'school_admin';
  } else if (membershipRole === 'teacher') {
    role = 'teacher';
  } else if (membershipRole) {
    role = membershipRole;
  }

  // Build the user object in PassPilot's expected shape
  const user = unifiedUser
    ? {
        id: unifiedUser.id,
        email: unifiedUser.email,
        role,
        roles,
        displayName:
          [unifiedUser.firstName, unifiedUser.lastName].filter(Boolean).join(' ') ||
          unifiedUser.email,
        profileImageUrl: unifiedUser.profileImageUrl || null,
        schoolId: activeSchoolId,
        kioskName: activeMembership?.kioskName || null,
      }
    : null;

  // Build the school object from active membership / school data
  const school = activeMembership
    ? {
        id: activeMembership.schoolId,
        name: activeMembership.schoolName || '',
        domain: activeMembership.schoolDomain || '',
        kioskEnabled: activeMembership.kioskEnabled ?? false,
        kioskRequiresApproval: activeMembership.kioskRequiresApproval ?? false,
        defaultPassDuration: activeMembership.defaultPassDuration ?? 15,
        schoolTimezone: activeMembership.schoolTimezone || 'America/New_York',
        activeGradeLevels: activeMembership.activeGradeLevels || [],
      }
    : null;

  const isAuthenticated = !!unifiedUser;
  const isAdmin = hasMembershipRole(activeMembership, 'admin', 'school_admin');
  const isSchoolwideManager = isAdmin || hasMembershipRole(activeMembership, 'office_staff');
  const isTeacher = hasMembershipRole(activeMembership, 'teacher');

  return {
    user,
    school,
    isLoading: loading,
    isAuthenticated,
    isAdmin,
    isSchoolwideManager,
    isTeacher,
    logout: async () => {
      await logout();
      queryClient.clear();
    },
    refetchUser,
  };
}
