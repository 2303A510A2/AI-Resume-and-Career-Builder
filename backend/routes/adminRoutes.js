const express = require('express');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const { protect } = require('../middleware/authMiddleware');
const { requireAdmin, requireMainAdmin, requirePermission, requirePasswordChanged } = require('../middleware/adminMiddleware');
const {
  login,
  requestAccess,
  requestStatus,
  me,
  updateOwnProfile,
  changePassword,
  sessions,
  revokeSessions,
  listRequests,
  approveRequest,
  rejectRequest,
  listCoAdmins,
  updateCoAdminPermissions,
  revokeCoAdmin,
  deleteCoAdmin,
  listUsers,
  getUserDetail,
  suspendUser,
  restoreUser,
  deleteUser,
  stats,
  systemHealth,
  listAudit,
  getSettings,
  updateSettings,
  listResumes,
  deleteResume,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} = require('../controllers/adminController');

const router = express.Router();

// Stricter limits on the credential-bearing endpoints.
const adminAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many admin authentication attempts. Try again later.' },
});

const adminRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many admin-access requests. Try again later.' },
});

// Reject malformed MongoDB ids BEFORE a controller query can throw a CastError
// (which would surface as an unhelpful 500). Authorization middlewares are
// mounted before this, so an unauthorized caller still receives 403, never 400.
const validObjectId = (param = 'id') => (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(String(req.params[param] || ''))) {
    return res.status(400).json({ success: false, code: 'INVALID_ID', message: 'Invalid identifier.' });
  }
  next();
};

// ---- Unauthenticated (credentials verified inside the handler) ----
router.post('/login', adminAuthLimiter, login);
router.post('/request', adminRequestLimiter, requestAccess);

// ---- Authenticated ordinary user (their own request status) ----
router.get('/request/status', protect, requestStatus);

// ---- Everything below requires an APPROVED, ACTIVE administrator ----
router.use(protect, requireAdmin);

// Always allowed, even before the forced initial password change.
router.get('/me', me);
router.put('/profile', updateOwnProfile);
router.post('/change-password', changePassword);
router.get('/sessions', sessions);
router.post('/sessions/revoke-all', revokeSessions);

// Normal administrative operations require the initial password to be changed.
router.use(requirePasswordChanged);

router.get('/stats', stats);
router.get('/system', systemHealth);

// Admin access requests — Main Admin Leader (or a co-admin granted the permission).
router.get('/requests', requirePermission('manageRequests'), listRequests);
router.post('/requests/:id/approve', requireMainAdmin, validObjectId('id'), approveRequest);
router.post('/requests/:id/reject', requireMainAdmin, validObjectId('id'), rejectRequest);

// Co-admin management — Main Admin Leader only.
router.get('/co-admins', requireMainAdmin, listCoAdmins);
router.patch('/co-admins/:id/permissions', requireMainAdmin, validObjectId('id'), updateCoAdminPermissions);
router.post('/co-admins/:id/revoke', requireMainAdmin, validObjectId('id'), revokeCoAdmin);
router.delete('/co-admins/:id', requireMainAdmin, validObjectId('id'), deleteCoAdmin);

// User management — permission-gated (Main Admin Leader has all permissions).
router.get('/users', requirePermission('manageUsers'), listUsers);
router.get('/users/:id', requirePermission('manageUsers'), validObjectId('id'), getUserDetail);
router.post('/users/:id/suspend', requireMainAdmin, validObjectId('id'), suspendUser);
router.post('/users/:id/restore', requireMainAdmin, validObjectId('id'), restoreUser);
router.delete('/users/:id', requirePermission('deleteUsers'), validObjectId('id'), deleteUser);

// Audit log — Main Admin Leader or the viewAudit permission.
router.get('/audit', requirePermission('viewAudit'), listAudit);

// The signed-in administrator's own notification inbox (every admin has one).
router.get('/notifications', listNotifications);
router.post('/notifications/:id/read', markNotificationRead);
router.post('/notifications/read-all', markAllNotificationsRead);

// Settings — readable by manageSettings, writable by the Main Admin Leader only.
router.get('/settings', requirePermission('manageSettings'), getSettings);
router.put('/settings', requireMainAdmin, updateSettings);

// Resume moderation.
router.get('/resumes', requirePermission('manageResumes'), listResumes);
router.delete('/resumes/:userId', requirePermission('manageResumes'), validObjectId('userId'), deleteResume);

module.exports = router;
