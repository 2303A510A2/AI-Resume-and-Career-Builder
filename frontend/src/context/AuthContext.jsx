import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../services/api';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [admin, setAdmin] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('token');
    const adminToken = localStorage.getItem('adminToken');

    const boot = async () => {
      try {
        if (token) {
          const { data } = await api.get('/auth/me');
          setUser(data.user);
        }
      } catch {
        // The api interceptor removes the token ONLY when the backend reports it
        // as expired/invalid. If the token is still present, this failure was a
        // transport problem (backend restarting, offline, timeout) — NOT a dead
        // session. Falling back to the cached profile keeps a still-valid 7-day
        // JWT signed in instead of bouncing the user to /login.
        if (localStorage.getItem('token')) {
          try {
            const cached = localStorage.getItem('user');
            if (cached) setUser(JSON.parse(cached));
          } catch {
            /* unreadable cache — stay signed out */
          }
        }
      }

      // Admin session is resolved independently: an expired/absent admin token
      // must never sign the ordinary user out (and vice-versa).
      if (adminToken) {
        try {
          const { data } = await api.get('/admin/me');
          setAdmin(data.admin);
          localStorage.setItem('admin', JSON.stringify(data.admin));
        } catch (err) {
          const status = err?.response?.status;
          // 401/403 => the admin session is genuinely invalid (expired, revoked or
          // the role was removed): drop it. A transport failure keeps the cached
          // admin so a backend restart does not bounce the operator to the login.
          if (status === 401 || status === 403) {
            localStorage.removeItem('adminToken');
            localStorage.removeItem('admin');
          } else {
            try {
              const cached = localStorage.getItem('admin');
              if (cached) setAdmin(JSON.parse(cached));
            } catch {
              /* ignore */
            }
          }
        }
      }

      setLoading(false);
    };
    boot();
  }, []);

  const login = useCallback(async (email, password) => {
    const { data } = await api.post('/auth/login', { email, password });
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    setUser(data.user);
    setAdmin(null);
    return data.user;
  }, []);

  const register = useCallback(async ({ name, email, password, confirmPassword }) => {
    const { data } = await api.post('/auth/register', { name, email, password, confirmPassword });
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    setUser(data.user);
    return data.user;
  }, []);

  const updateUser = useCallback((nextUser) => {
    setUser(nextUser);
    localStorage.setItem('user', JSON.stringify(nextUser));
  }, []);

  // Persist a fresh admin session (login, password change, session revoke).
  const applyAdminSession = useCallback((token, nextAdmin) => {
    if (token) localStorage.setItem('adminToken', token);
    if (nextAdmin) {
      localStorage.setItem('admin', JSON.stringify(nextAdmin));
      setAdmin(nextAdmin);
    }
  }, []);

  const adminLogin = useCallback(async (email, password) => {
    const { data } = await api.post('/admin/login', { email, password });
    applyAdminSession(data.token, data.admin);
    return data.admin;
  }, [applyAdminSession]);

  const updateAdmin = useCallback((nextAdmin) => {
    localStorage.setItem('admin', JSON.stringify(nextAdmin));
    setAdmin(nextAdmin);
  }, []);

  // File an admin-access request. Verified by the applicant's own credentials on
  // the backend; it grants NO session and NO permissions.
  const requestAdminAccess = useCallback((payload) => api.post('/admin/request', payload), []);
  const adminRequestStatus = useCallback(() => api.get('/admin/request/status'), []);

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
  }, []);

  const adminLogout = useCallback(() => {
    localStorage.removeItem('adminToken');
    localStorage.removeItem('admin');
    setAdmin(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        admin,
        loading,
        login,
        register,
        logout,
        adminLogin,
        adminLogout,
        updateUser,
        applyAdminSession,
        updateAdmin,
        requestAdminAccess,
        adminRequestStatus,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
};
