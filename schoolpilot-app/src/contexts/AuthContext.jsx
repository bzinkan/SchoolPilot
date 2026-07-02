import { createContext, useContext, useState, useEffect, useCallback } from 'react';
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
  // Token kept in memory only — never persisted to localStorage (XSS protection)
  const [token, setToken] = useState(null);

  const fetchUser = useCallback(async () => {
    try {
      // On native, restore persisted token before first API call
      if (!token) {
        const stored = await loadToken();
        if (stored) {
          setToken(stored);
          setApiToken(stored);
        }
      }

      const res = await api.get('/auth/me');
      const nextMemberships = res.data.memberships || [];
      setUser(res.data.user);
      setMemberships(nextMemberships);
      setLicenses(res.data.licenses || {});

      // Store JWT token in memory (returned by /me for WebSocket auth)
      if (res.data.token) {
        setToken(res.data.token);
        saveToken(res.data.token); // persist for native app relaunch
      } else if (res.data.user?.impersonating) {
        setToken(null);
        setApiToken(null);
        await clearToken();
      }

      const selectedSchoolIsValid =
        activeSchoolId && nextMemberships.some((m) => m.schoolId === activeSchoolId);

      // Default to first membership's school if none selected, or repair a stale
      // local selection after membership changes.
      if ((!activeSchoolId || !selectedSchoolIsValid) && nextMemberships.length > 0) {
        const defaultSchool = nextMemberships[0].schoolId;
        setActiveSchoolId(defaultSchool);
        localStorage.setItem('sp_activeSchoolId', defaultSchool);
      }
    } catch {
      setUser(null);
      setMemberships([]);
      setLicenses({});
    } finally {
      setLoading(false);
    }
  }, [activeSchoolId, token]);

  // Sync in-memory token to API interceptor
  useEffect(() => {
    setApiToken(token);
  }, [token]);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  const login = async (email, password) => {
    const res = await api.post('/auth/login', { email, password });
    setUser(res.data.user);
    setMemberships(res.data.memberships || []);

    // Store JWT token for WebSocket auth + native persistence
    if (res.data.token) {
      setToken(res.data.token);
      saveToken(res.data.token);
    }

    if (res.data.memberships?.length > 0) {
      const schoolId = res.data.memberships[0].schoolId;
      setActiveSchoolId(schoolId);
      localStorage.setItem('sp_activeSchoolId', schoolId);
    }

    // Refetch to get licenses
    await fetchUser();
    return res.data;
  };

  const register = async (data) => {
    const res = await api.post('/auth/register', data);
    setUser(res.data.user);

    if (res.data.token) {
      setToken(res.data.token);
      saveToken(res.data.token);
    }

    await fetchUser();
    return res.data;
  };

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // ignore
    }
    setUser(null);
    setMemberships([]);
    setLicenses({});
    setActiveSchoolId(null);
    setToken(null);
    clearToken(); // clear native persisted token
    localStorage.removeItem('sp_activeSchoolId');
  };

  const stopImpersonating = async () => {
    setToken(null);
    setApiToken(null);
    await clearToken();
    const res = await api.post('/super-admin/stop-impersonate');
    await fetchUser();
    return res.data;
  };

  const switchSchool = (schoolId) => {
    setActiveSchoolId(schoolId);
    localStorage.setItem('sp_activeSchoolId', schoolId);
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
