const { getSettings } = require('../services/settingsService');

// Maintenance mode: when enabled through admin settings, ordinary API traffic is
// paused with an honest 503. Admin, auth and health routes stay reachable so the
// operator can always turn it back off and users can still sign in.
//
// This is a REAL behaviour change, not a decorative toggle. It is disabled by
// default and only the Main Admin Leader can enable it.
const EXEMPT = [
  /^\/api\/health$/,
  /^\/health$/,
  /^\/api\/admin(\/|$)/,
  /^\/api\/auth(\/|$)/,
  /^\/$/,
];

module.exports = async function maintenanceMode(req, res, next) {
  // Check the exempt paths FIRST, before any database access. The health probe,
  // sign-in and the admin portal must always answer even when the database is
  // down, otherwise a disconnected MongoDB would make the backend look offline.
  const p = req.path || req.originalUrl || '';
  if (EXEMPT.some((re) => re.test(p))) return next();
  try {
    const settings = await getSettings();
    if (!settings.maintenanceMode.enabled) return next();
    return res.status(503).json({
      success: false,
      code: 'MAINTENANCE_MODE',
      retryable: true,
      message: settings.maintenanceMode.message,
    });
  } catch {
    return next();
  }
};
