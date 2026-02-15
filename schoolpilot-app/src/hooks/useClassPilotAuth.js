import { useAuth } from '../contexts/AuthContext';

/**
 * Adapter hook that maps the unified AuthContext to the shape
 * expected by ClassPilot pages.
 *
 * ClassPilot originally does `useQuery({ queryKey: ['/api/me'] })` inline
 * and expects `{ success, user: { id, email, role, schoolName, ... } }`.
 *
 * This hook provides the same data without an extra network request by
 * reading from the already-fetched AuthContext.
 */
export function useClassPilotAuth() {
  const { user, token, loading, logout, activeSchoolId, activeMembership, refetchUser } = useAuth();

  // Derive ClassPilot role from unified membership
  // ClassPilot uses 'school_admin' or 'teacher'
  const role = activeMembership?.role || null;

  // Build the currentUser object in the shape ClassPilot pages expect
  const currentUser = user
    ? {
        id: user.id,
        email: user.email,
        role,
        schoolId: activeSchoolId,
        schoolName: activeMembership?.schoolName || '',
        displayName: user.firstName && user.lastName
          ? `${user.firstName} ${user.lastName}`
          : user.firstName || user.email,
        profileImageUrl: user.profileImageUrl || null,
        impersonating: false,
      }
    : null;

  // Build the school object from active membership
  const school = activeMembership
    ? {
        id: activeMembership.schoolId,
        name: activeMembership.schoolName || '',
        timezone: activeMembership.schoolTimezone || 'America/New_York',
      }
    : null;

  const isAuthenticated = !!user;

  return {
    currentUser,
    school,
    isAdmin: role === 'school_admin' || role === 'admin',
    isTeacher: role === 'teacher',
    isAuthenticated,
    isLoading: loading,
    token,
    logout,
    refetchUser,
  };
}
