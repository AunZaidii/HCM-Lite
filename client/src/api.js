import axios from 'axios';

export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';
const TOKEN_KEY = 'hcm_token';

export const tokenStore = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: (t) => { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode */ } },
  clear: () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } },
};

export const api = axios.create({ baseURL: API_URL, timeout: 30000 });

api.interceptors.request.use((config) => {
  const t = tokenStore.get();
  if (t) config.headers.Authorization = `Bearer ${t}`;
  return config;
});

let onAuthError = () => {};
export const setAuthErrorHandler = (fn) => { onAuthError = fn; };

api.interceptors.response.use(
  (r) => r,
  (err) => {
    const code = err.response?.data?.error?.code;
    if (err.response?.status === 401 && !err.config.url.includes('/auth/login')) onAuthError('logout');
    if (code === 'PASSWORD_CHANGE_REQUIRED') onAuthError('password');
    return Promise.reject(err);
  },
);

export const errMsg = (err) =>
  err?.response?.data?.error?.message || (err?.code === 'ERR_NETWORK' ? 'Cannot reach the server' : err?.message) || 'Something went wrong';

export const errDetails = (err) => err?.response?.data?.error?.details || [];

// GET helper for react-query
export const get = (url, params) => api.get(url, { params }).then((r) => r.data);

// Downloads a protected file (PDF/CSV) using the JWT.
export async function download(url, fallbackName, params) {
  const res = await api.get(url, { params, responseType: 'blob' });
  const cd = res.headers['content-disposition'] || '';
  const name = /filename="?([^";]+)"?/.exec(cd)?.[1] || fallbackName;
  const href = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.click();
  URL.revokeObjectURL(href);
}

export function saveText(text, name, type = 'text/csv') {
  const href = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.click();
  URL.revokeObjectURL(href);
}
