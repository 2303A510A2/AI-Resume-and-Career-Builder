const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Admin = require('../models/Admin');
const { getAuthSecret } = require('../utils/authConfig');

// Verifies the Bearer token. Returns `{ ok: true, decoded }` or
// `{ ok: false, code }` where `code` says WHY it failed:
//   TOKEN_MISSING - no (or malformed) Authorization header was sent at all
//   TOKEN_EXPIRED - signature was valid but `exp` has passed
//   TOKEN_INVALID - bad signature / malformed / wrong algorithm
//
// The reason matters to the client: only a genuinely expired or invalid token
// may be reported as "your session has expired". A request that simply failed
// to ATTACH a token (e.g. the frontend lost its in-memory copy) must NOT be
// mistaken for an expired session, otherwise a valid 7-day JWT gets thrown
// away and the user is logged out for no reason.
const attachUser = (req) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ') || !header.slice(7).trim()) {
    return { ok: false, code: 'TOKEN_MISSING' };
  }
  try {
    const decoded = jwt.verify(header.slice(7).trim(), getAuthSecret());
    return { ok: true, decoded };
  } catch (err) {
    if (err && err.code === 'AUTH_CONFIG_MISSING') {
      return { ok: false, code: 'AUTH_CONFIG_MISSING' };
    }
    if (err && err.name === 'TokenExpiredError') {
      return { ok: false, code: 'TOKEN_EXPIRED', expiredAt: err.expiredAt };
    }
    return { ok: false, code: 'TOKEN_INVALID' };
  }
};

// Protects routes. Accepts tokens minted for users OR administrators.
//
// IMPORTANT: authorization NEVER trusts `decoded.role` from the token. The token
// is only used to find the account; the EFFECTIVE role is read from the database
// record (`req.userRecord.role`). That is what makes a revoked/demoted admin lose
// access immediately even while an old JWT is still cryptographically valid.
const protect = async (req, res, next) => {
  const result = attachUser(req);
  if (!result.ok) {
    const messages = {
      TOKEN_MISSING: 'Not authorized, token missing or invalid',
      TOKEN_EXPIRED: 'Session expired, please sign in again',
      TOKEN_INVALID: 'Not authorized, token missing or invalid',
      AUTH_CONFIG_MISSING: 'Authentication is temporarily unavailable. Please contact support.',
    };
    return res.status(401).json({
      success: false,
      message: messages[result.code] || 'Not authorized, token missing or invalid',
      code: result.code,
    });
  }

  const decoded = result.decoded;
  // Legacy administrator tokens (separate Admin collection, role 'admin') are
  // still resolved so nothing breaks for old sessions; new admin roles live on
  // the User collection.
  const Model = decoded.role === 'admin' ? Admin : User;
  const record = await Model.findById(decoded.id).select('-password');
  if (!record) {
    return res.status(401).json({ success: false, message: 'Not authorized, account not found', code: 'ACCOUNT_NOT_FOUND' });
  }

  // A suspended account is blocked even if its token was issued before the
  // suspension. This applies to ordinary users AND to suspended admins.
  if (Model === User && record.isActive === false) {
    return res.status(403).json({
      success: false,
      code: 'ACCOUNT_BLOCKED',
      message: 'This account has been blocked by an administrator. Please contact support.',
    });
  }

  req.user = { id: decoded.id, role: record.role || decoded.role };
  req.userRecord = record;
  req.auth = decoded;
  next();
};

module.exports = { protect, attachUser };
