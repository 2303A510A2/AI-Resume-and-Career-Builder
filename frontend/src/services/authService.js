import api from './api';

export const login = (email, password) => api.post('/auth/login', { email, password });
export const register = (payload) => api.post('/auth/register', payload);
export const getMe = () => api.get('/auth/me');
export const updateProfile = (payload) => api.put('/auth/profile', payload);
export const forgotPassword = (email) => api.post('/auth/forgot-password', { email });
export const verifyOtp = (email, otp) => api.post('/auth/verify-otp', { email, otp });
export const resetPassword = (resetToken, password, confirmPassword) =>
  api.post('/auth/reset-password', { resetToken, password, confirmPassword });

// ---------------------------------------------------------------------------
// The ONE token used for every request.
//
// The JWT is minted once (login / register / verify-otp) and stays valid for its
// full lifetime (JWT_EXPIRES_IN = 7d). Nothing here ever creates, refreshes or
// re-mints a token, so all chat requests carry the same valid token.
// `inspectToken()` is a read-only, local check (structure + `exp`) run BEFORE a
// message is sent, so a dead token is never sent and a live one is never treated
// as expired.
// ---------------------------------------------------------------------------
const TOKEN_KEY = 'token';

export const getAuthToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
};

const decodeSegment = (segment) => {
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
};

/** @returns {{ok:boolean, reason:'valid'|'missing'|'malformed'|'expired', secondsLeft:number|null}} */
export const inspectToken = (token = getAuthToken()) => {
  if (!token || !String(token).trim()) return { ok: false, reason: 'missing', secondsLeft: null };
  let payload = null;
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed', secondsLeft: null };
    payload = JSON.parse(decodeSegment(parts[1]));
  } catch {
    return { ok: false, reason: 'malformed', secondsLeft: null };
  }
  if (!payload || typeof payload.exp !== 'number') return { ok: false, reason: 'malformed', secondsLeft: null };
  const secondsLeft = payload.exp - Math.floor(Date.now() / 1000);
  return { ok: secondsLeft > 0, reason: secondsLeft > 0 ? 'valid' : 'expired', secondsLeft };
};

/** Drops the stored session. ONLY called for a genuinely dead token. */
export const clearToken = () => {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem('user');
  } catch {
    /* private mode */
  }
};