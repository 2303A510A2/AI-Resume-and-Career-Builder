// Server-side authorization for every /api/admin endpoint. The frontend is NEVER
// the authority: these middlewares read the EFFECTIVE role from the database
// record loaded by protect(), so hiding a button (or forging a role value in a
// request body/token) can never grant access.

const ADMIN_ROLES = ['co_admin', 'main_admin'];

/**
 * Requires an approved administrator (co_admin or main_admin), an active account,
 * and a session version that has not been revoked.
 */
const requireAdmin = (req, res, next) => {
  const rec = req.userRecord;
  if (!rec || !ADMIN_ROLES.includes(rec.role)) {
    return res.status(403).json({ success: false, code: 'ADMIN_REQUIRED', message: 'Administrator access required.' });
  }
  if (rec.isActive === false) {
    return res.status(403).json({ success: false, code: 'ACCOUNT_DISABLED', message: 'This administrator account is suspended.' });
  }
  // Stateless-JWT session revocation: admin tokens carry `av`. If the account's
  // adminTokenVersion was incremented (access revoked / "sign out everywhere"),
  // every previously issued admin token is dead.
  const av = req.auth ? req.auth.av : undefined;
  if (av !== undefined && Number(av) !== Number(rec.adminTokenVersion || 0)) {
    return res.status(401).json({
      success: false,
      code: 'SESSION_REVOKED',
      message: 'Your administrative session was revoked. Please sign in again.',
    });
  }
  req.admin = rec;
  next();
};

/** Only the single Main Admin Leader. */
const requireMainAdmin = (req, res, next) => {
  if (!req.admin || req.admin.role !== 'main_admin') {
    return res.status(403).json({
      success: false,
      code: 'MAIN_ADMIN_REQUIRED',
      message: 'Only the Main Admin Leader can perform this action.',
    });
  }
  next();
};

/**
 * Requires a specific fine-grained permission. The Main Admin Leader always
 * passes; a co_admin must have the flag explicitly set by the Main Admin Leader.
 */
const requirePermission = (perm) => (req, res, next) => {
  const p = req.admin;
  if (!p) {
    return res.status(403).json({ success: false, code: 'ADMIN_REQUIRED', message: 'Administrator access required.' });
  }
  if (p.role === 'main_admin') return next();
  if (p.adminPermissions && p.adminPermissions[perm] === true) return next();
  return res.status(403).json({
    success: false,
    code: 'PERMISSION_DENIED',
    message: 'Your administrator role does not include this permission.',
  });
};

/**
 * Blocks normal admin operations until the initial password has been changed.
 * Mounted AFTER the few always-allowed routes (me / change-password / sessions).
 */
const requirePasswordChanged = (req, res, next) => {
  if (req.admin && req.admin.mustChangePassword) {
    return res.status(403).json({
      success: false,
      code: 'PASSWORD_CHANGE_REQUIRED',
      message: 'You must change your initial password before continuing.',
    });
  }
  next();
};

module.exports = { requireAdmin, requireMainAdmin, requirePermission, requirePasswordChanged, ADMIN_ROLES };
