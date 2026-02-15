import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../shared/utils/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [memberships, setMemberships] = useState([]);
  const [licenses, setLicenses] = useState({});
  const [loading, setLoading] = useState(true);
  const [activeSchoolId, setActiveSchoolId] = useState(
    () => localStorage.getItem('sp_activeSchoolId') || null
  );
  const [token, setToken] = useState(
    () => localStorage.getItem('sp_token') || null
  );

  const fetchUser = useCallback(async () => {
    try {
      const res = await api.get('/auth/me');
      setUser(res.data.user);
      setMemberships(res.data.memberships || []);
      setLicenses(res.data.licenses || {});

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
  }, [activeSchoolId]);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  const login = async (email, password) => {
    const res = await api.post('/auth/login', { email, password });
    setUser(res.data.user);
    setMemberships(res.data.memberships || []);

    // Store JWT token for socket.io auth (GoPilot real-time)
    if (res.data.token) {
      setToken(res.data.token);
      localStorage.setItem('sp_token', res.data.token);
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
    localStorage.removeItem('sp_activeSchoolId');
    localStorage.removeItem('sp_token');
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
