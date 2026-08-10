import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import api, { setApiToken } from '../shared/utils/api';
import { saveToken, loadToken, clearToken } from '../native/storage';

const AuthContext = createContext(null);

const GOPILOT_ROLE_PRIORITY = {
  admin: 5,
  school_admin: 4,
  office_staff: 3,
  teacher: 2,
  parent: 1,
};

function effectiveGoPilotRole(membership) {
  return membership?.gopilotRole || membership?.role || '';
}

function selectMembershipForSchool(memberships, activeSchoolId) {
  const schoolMemberships = memberships.filter((m) => m.schoolId === activeSchoolId);
  if (schoolMemberships.length <= 1) return schoolMemberships[0] || null;
  return [...schoolMemberships].sort((a, b) => {
    const roleDelta =
      (GOPILOT_ROLE_PRIORITY[effectiveGoPilotRole(b)] || 0) -
      (GOPILOT_ROLE_PRIORITY[effectiveGoPilotRole(a)] || 0);
    if (roleDelta !== 0) return roleDelta;
    return (a.id || '').localeCompare(b.id || '');
  })[0];
}

export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState(null);
  const [memberships, setMemberships] = useState([]);
  const [licenses, setLicenses] = useState({});
  const [loading, setLoading] = useState(true);
  const [activeSchoolId, setActiveSchoolId] = useState(
    () => localStorage.getItem('sp_activeSchoolId') || null
  );
  const activeSchoolIdRef = useRef(activeSchoolId);
  // Token kept in memory only — never persisted to localStorage (XSS protection)
  const [token, setToken] = useState(null);
  const tokenRef = useRef(null);
  const authRequestIdRef = useRef(0);

  const publishToken = useCallback((nextToken) => {
    const normalizedToken = nextToken || null;
    tokenRef.current = normalizedToken;
    setApiToken(normalizedToken);
    setToken(normalizedToken);
  }, []);

  const acceptToken = useCallback((nextToken) => {
    publishToken(nextToken);
    // Native secure storage must not delay or invalidate an otherwise
    // successful in-memory authentication transition.
    const persistence = nextToken ? saveToken(nextToken) : clearToken();
    void persistence.catch(() => {});
  }, [publishToken]);

  const selectActiveSchool = useCallback((schoolId) => {
    const normalizedSchoolId = schoolId || null;
    activeSchoolIdRef.current = normalizedSchoolId;
    setActiveSchoolId(normalizedSchoolId);
    if (normalizedSchoolId) {
      localStorage.setItem('sp_activeSchoolId', normalizedSchoolId);
    } else {
      localStorage.removeItem('sp_activeSchoolId');
    }
  }, []);

  const fetchUser = useCallback(async ({ throwOnError = false } = {}) => {
    const requestId = ++authRequestIdRef.current;
    const isLatestRequest = () => requestId === authRequestIdRef.current;
    try {
      // On native, restore persisted token before first API call
      if (!tokenRef.current) {
        const stored = await loadToken().catch(() => null);
        if (!isLatestRequest()) return null;
        if (stored) {
          publishToken(stored);
        }
      }

      const res = await api.get('/auth/me');
      if (!isLatestRequest()) return null;
      const nextMemberships = res.data.memberships || [];

      // Publish the JWT synchronously before exposing authenticated UI. Child
      // dashboards issue requests as soon as `user` becomes available.
      if (res.data.token) {
        acceptToken(res.data.token);
      } else if (res.data.user?.impersonating) {
        acceptToken(null);
      }

      const selectedSchoolId = activeSchoolIdRef.current;
      const selectedSchoolIsValid =
        selectedSchoolId && nextMemberships.some((m) => m.schoolId === selectedSchoolId);
      const resolvedSchoolId = nextMemberships.some(
        (m) => m.schoolId === res.data.activeSchoolId
      )
        ? res.data.activeSchoolId
        : null;

      // Default to first membership's school if none selected, or repair a stale
      // local selection after membership changes.
      if (resolvedSchoolId) {
        selectActiveSchool(resolvedSchoolId);
      } else if ((!selectedSchoolId || !selectedSchoolIsValid) && nextMemberships.length > 0) {
        selectActiveSchool(nextMemberships[0].schoolId);
      } else if (nextMemberships.length === 0) {
        selectActiveSchool(null);
      }

      // Repair the selected tenant before exposing the authenticated user.
      // Product routes mount immediately when `user` becomes available.
      setUser(res.data.user);
      setMemberships(nextMemberships);
      setLicenses(res.data.licenses || {});
      return res.data;
    } catch (error) {
      if (!isLatestRequest()) return null;
      if ([401, 403].includes(error.response?.status)) {
        acceptToken(null);
        if (error.response?.status === 403) selectActiveSchool(null);
      }
      setUser(null);
      setMemberships([]);
      setLicenses({});
      if (throwOnError) throw error;
      return null;
    } finally {
      if (isLatestRequest()) setLoading(false);
    }
  }, [acceptToken, publishToken, selectActiveSchool]);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  const login = async (email, password) => {
    const res = await api.post('/auth/login', { email, password });

    // Axios uses a module-level in-memory token. Publish it before any state
    // update can mount protected routes or before /auth/me is requested.
    if (res.data.token) {
      acceptToken(res.data.token);
    }

    if (res.data.memberships?.length > 0) {
      selectActiveSchool(res.data.memberships[0].schoolId);
    }

    // Refetch to get licenses before exposing authenticated product routes.
    await fetchUser({ throwOnError: true });
    return res.data;
  };

  const register = async (data) => {
    const res = await api.post('/auth/register', data);

    if (res.data.token) {
      acceptToken(res.data.token);
    }

    selectActiveSchool(res.data.membership?.schoolId || res.data.school?.id || null);
    await fetchUser({ throwOnError: true });
    return res.data;
  };

  const logout = async () => {
    authRequestIdRef.current += 1;
    try {
      await api.post('/auth/logout');
    } catch {
      // ignore
    }
    setUser(null);
    setMemberships([]);
    setLicenses({});
    selectActiveSchool(null);
    acceptToken(null);
  };

  const stopImpersonating = async () => {
    authRequestIdRef.current += 1;
    acceptToken(null);
    const res = await api.post('/super-admin/stop-impersonate');
    await fetchUser();
    return res.data;
  };

  const switchSchool = (schoolId) => {
    selectActiveSchool(schoolId);
    queryClient.clear();
    // Refetch to get new school's licenses
    fetchUser();
  };

  const activeMembership = selectMembershipForSchool(memberships, activeSchoolId);

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        memberships,
        licenses,
        loading,
        login,
        register,
        logout,
        stopImpersonating,
        switchSchool,
        activeSchoolId,
        activeMembership,
        refetchUser: fetchUser,
        acceptToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
