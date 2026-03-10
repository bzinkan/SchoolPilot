import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api, { setApiToken } from '../shared/utils/api';
import { saveToken, loadToken, clearToken } from '../native/storage';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
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
      setUser(res.data.user);
      setMemberships(res.data.memberships || []);
      setLicenses(res.data.licenses || {});

      // Store JWT token in memory (returned by /me for WebSocket auth)
      if (res.data.token) {
        setToken(res.data.token);
        saveToken(res.data.token); // persist for native app relaunch
      }

      // Default to first membership's school if none selected
      if (!activeSchoolId && res.data.memberships?.length > 0) {
        const defaultSchool = res.data.memberships[0].schoolId;
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

  const switchSchool = (schoolId) => {
    setActiveSchoolId(schoolId);
    localStorage.setItem('sp_activeSchoolId', schoolId);
    // Refetch to get new school's licenses
    fetchUser();
  };

  const activeMembership = memberships.find((m) => m.schoolId === activeSchoolId);

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
