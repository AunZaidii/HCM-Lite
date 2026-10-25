import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setAuthErrorHandler, tokenStore } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, employee: null, company: null });

  const loadMe = useCallback(async () => {
    if (!tokenStore.get()) return setState({ loading: false, user: null, employee: null, company: null });
    try {
      const { data } = await api.get('/auth/me');
      setState({ loading: false, ...data });
    } catch {
      tokenStore.clear();
      setState({ loading: false, user: null, employee: null, company: null });
    }
  }, []);

  useEffect(() => { loadMe(); }, [loadMe]);

  const signIn = useCallback(async (token) => {
    tokenStore.set(token);
    await loadMe();
  }, [loadMe]);

  const signOut = useCallback(async () => {
    try { await api.post('/auth/logout'); } catch { /* token may be invalid already */ }
    tokenStore.clear();
    setState({ loading: false, user: null, employee: null, company: null });
  }, []);

  useEffect(() => {
    setAuthErrorHandler((kind) => {
      if (kind === 'logout') { tokenStore.clear(); setState({ loading: false, user: null, employee: null, company: null }); }
      if (kind === 'password') setState((s) => (s.user ? { ...s, user: { ...s.user, mustChangePassword: true } } : s));
    });
  }, []);

  const value = useMemo(() => ({ ...state, signIn, signOut, reload: loadMe }), [state, signIn, signOut, loadMe]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
