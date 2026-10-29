import api from './api';

// ---------------------------------------------------------------------------
// Admin portal API surface. EVERY one of these endpoints is authorized on the
// BACKEND (roles + permissions + forced-password-change gate); nothing here is
// a security boundary — the client only chooses what to display.
// ---------------------------------------------------------------------------

// --- Session / account ---
export const adminLogin = (email, password) => api.post('/admin/login', { email, password });
export const adminMe = () => api.get('/admin/me');
export const adminUpdateProfile = (payload) => api.put('/admin/profile', payload);
export const adminChangePassword = (payload) => api.post('/admin/change-password', payload);
export const adminSessions = () => api.get('/admin/sessions');
export const adminRevokeSessions = () => api.post('/admin/sessions/revoke-all');

// --- Admin access requests ---
// `requestAdminAccess` verifies the applicant's own credentials server-side and
// GRANTS NOTHING; it only files a pending request for the Main Admin Leader.
export const requestAdminAccess = (payload) => api.post('/admin/request', payload);
export const adminRequestStatus = () => api.get('/admin/request/status');

// --- Dashboard / monitoring ---
export const getAdminStats = () => api.get('/admin/stats');
export const getSystemHealth = () => api.get('/admin/system');

// --- Access requests (view: manageRequests; decide: Main Admin Leader) ---
export const listAdminRequests = (params = {}) => api.get('/admin/requests', { params });
export const approveAdminRequest = (id) => api.post(`/admin/requests/${id}/approve`);
export const rejectAdminRequest = (id, note = '') => api.post(`/admin/requests/${id}/reject`, { note });

// --- Co-admin management (Main Admin Leader only) ---
export const listCoAdmins = () => api.get('/admin/co-admins');
export const updateCoAdminPermissions = (id, permissions) =>
  api.patch(`/admin/co-admins/${id}/permissions`, { permissions });
export const revokeCoAdmin = (id) => api.post(`/admin/co-admins/${id}/revoke`);
export const deleteCoAdmin = (id) => api.delete(`/admin/co-admins/${id}`, { data: { confirm: true } });

// --- User management ---
export const listUsers = (params = {}) => api.get('/admin/users', { params });
export const getUserDetail = (id) => api.get(`/admin/users/${id}`);
export const suspendUser = (id, reason = '') => api.post(`/admin/users/${id}/suspend`, { reason });
export const restoreUser = (id) => api.post(`/admin/users/${id}/restore`);
export const deleteUser = (id) => api.delete(`/admin/users/${id}`, { data: { confirm: true } });

// --- Audit log (read-only; the backend exposes no delete/update route) ---
export const listAudit = (params = {}) => api.get('/admin/audit', { params });

// --- Notifications (every administrator has their own inbox) ---
export const listAdminNotifications = (params = {}) => api.get('/admin/notifications', { params });
export const readAdminNotification = (id) => api.post(`/admin/notifications/${id}/read`);
export const readAllAdminNotifications = () => api.post('/admin/notifications/read-all');

// --- Settings / limits ---
export const getAdminSettings = () => api.get('/admin/settings');
export const updateAdminSettings = (patch) => api.put('/admin/settings', patch);

// --- Resume moderation (existing feature) ---
export const listResumes = (params = {}) => api.get('/admin/resumes', { params });
export const deleteUserResume = (userId) => api.delete(`/admin/resumes/${userId}`);
