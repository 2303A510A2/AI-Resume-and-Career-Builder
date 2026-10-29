const AuditLog = require('../models/AuditLog');

// Best-effort audit recorder. It must NEVER break the action it describes and it
// must NEVER store sensitive material. `meta` is filtered to a small allowlist of
// primitive fields; anything unknown/oversized is dropped.
const SAFE_META_KEYS = new Set([
  'status', 'previousStatus', 'from', 'to', 'role', 'previousRole', 'permission',
  'permissions', 'reason', 'note', 'count', 'enabled', 'scope', 'email', 'name',
]);

const scrubMeta = (meta) => {
  if (!meta || typeof meta !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!SAFE_META_KEYS.has(k)) continue;
    if (v == null) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string').slice(0, 20).map((x) => x.slice(0, 60));
    else if (typeof v === 'object') {
      const nested = {};
      for (const [nk, nv] of Object.entries(v)) {
        if (typeof nv === 'boolean') nested[nk] = nv;
      }
      if (Object.keys(nested).length) out[k] = nested;
    }
  }
  return out;
};

/**
 * Record one administrative action. Never throws.
 * @param {object} p
 * @param {object} [p.actor] resolved actor record ({_id,email,role}) or req.userRecord
 * @param {object} [p.req] Express request (used only for IP + actor fallback)
 */
const record = async ({ actor, req, action, targetType = '', targetId = '', targetLabel = '', meta = {} }) => {
  try {
    const a = actor || (req && req.userRecord);
    const ip = req
      ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || ''
      : '';
    await AuditLog.create({
      actorId: a && a._id ? a._id : null,
      actorEmail: a && a.email ? String(a.email) : '',
      actorRole: a && a.role ? String(a.role) : '',
      action: String(action || 'unknown').slice(0, 100),
      targetType: String(targetType || '').slice(0, 60),
      targetId: targetId ? String(targetId).slice(0, 80) : '',
      targetLabel: String(targetLabel || '').slice(0, 200),
      meta: scrubMeta(meta),
      ip: ip.slice(0, 60),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[audit] failed to record:', err.message);
  }
};

module.exports = { record, scrubMeta };
